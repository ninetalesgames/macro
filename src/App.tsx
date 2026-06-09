import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithPopup, type User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import "./App.css";
import Coach from "./Coach";
import { auth, db, googleProvider } from "./firebase";
import type { CoachProposal, DayEntry, EntriesMap, Goals } from "./types";
type CalendarMode = "calories" | "protein" | "weight";

const DEFAULT_CALORIE_TARGET = 2100;
const DEFAULT_PROTEIN_TARGET = 160;
const STORAGE_KEY = "macro-journal-v2-entries";

function getUserStorageKey(userId: string) {
  return `${STORAGE_KEY}-${userId}`;
}

function loadLocalEntries(storageKey = STORAGE_KEY): EntriesMap {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function cleanEntry(entry: DayEntry): DayEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as DayEntry;
}

function getSaveStatusLabel(status: "local" | "saving" | "synced" | "error") {
  if (status === "saving") return "Syncing";
  if (status === "synced") return "Synced";
  if (status === "error") return "Sync issue";
  return "Saved locally";
}

function getLocalDateString(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey: string) {
  return new Date(`${dateKey}T00:00:00`);
}

function formatLongDate(dateKey: string) {
  return parseDateKey(dateKey).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatMonthYear(date: Date) {
  return date.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

function getMonthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthEnd(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function getMonthGrid(viewMonth: Date) {
  const start = getMonthStart(viewMonth);
  const end = getMonthEnd(viewMonth);
  const mondayIndex = start.getDay() === 0 ? 6 : start.getDay() - 1;
  const grid: (Date | null)[] = Array.from({ length: mondayIndex }, () => null);

  for (let day = 1; day <= end.getDate(); day++) {
    grid.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day));
  }

  while (grid.length % 7 !== 0) grid.push(null);
  return grid;
}

function getDayEntry(entries: EntriesMap, dateKey: string): DayEntry {
  return entries[dateKey] ?? {};
}

function getAverage(
  entries: EntriesMap,
  endDateKey: string,
  days: number,
  field: "calories" | "protein" | "weight",
) {
  const endDate = parseDateKey(endDateKey);
  const values: number[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - i);
    const value = entries[getLocalDateString(date)]?.[field];
    if (typeof value === "number" && !Number.isNaN(value)) values.push(value);
  }

  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getWeightTrend(entries: EntriesMap, endDateKey: string) {
  const currentAvg = getAverage(entries, endDateKey, 7, "weight");
  const earlierEnd = parseDateKey(endDateKey);
  earlierEnd.setDate(earlierEnd.getDate() - 7);
  const earlierAvg = getAverage(entries, getLocalDateString(earlierEnd), 7, "weight");

  if (currentAvg === undefined || earlierAvg === undefined) {
    return {
      diff: undefined as number | undefined,
      label: "Need more logs",
      description: "Log weight across two weeks to see a trend",
      tone: "empty",
    };
  }

  const diff = Number((currentAvg - earlierAvg).toFixed(2));
  if (Math.abs(diff) < 0.15) {
    return {
      diff,
      label: "Stable",
      description: "Compared with the previous 7 days",
      tone: "maintain",
    };
  }

  return {
    diff,
    label: diff > 0 ? "Trending up" : "Trending down",
    description: "Compared with the previous 7 days",
    tone: diff > 0 ? "bulk" : "cut",
  };
}

function toneClass(tone: string) {
  if (tone === "cut") return "tone-cut";
  if (tone === "bulk") return "tone-bulk";
  if (tone === "maintain") return "tone-maintain";
  return "tone-empty";
}

function getPreviousLoggedWeight(entries: EntriesMap, dateKey: string) {
  const base = parseDateKey(dateKey);
  for (let i = 1; i <= 30; i++) {
    const previous = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    const weight = entries[getLocalDateString(previous)]?.weight;
    if (typeof weight === "number" && !Number.isNaN(weight)) return weight;
  }
  return undefined;
}

function getCalendarTone(
  mode: CalendarMode,
  entry: DayEntry,
  entries: EntriesMap,
  dateKey: string,
  goals: Goals,
) {
  if (mode === "calories") {
    if (entry.calories === undefined) return "empty";
    if (entry.calories <= goals.calories - 150) return "cut";
    if (entry.calories >= goals.calories + 150) return "bulk";
    return "maintain";
  }

  if (mode === "protein") {
    if (entry.protein === undefined) return "empty";
    if (entry.protein >= goals.protein) return "cut";
    if (entry.protein >= goals.protein * 0.8) return "maintain";
    return "bulk";
  }

  if (entry.weight === undefined) return "empty";
  const previousWeight = getPreviousLoggedWeight(entries, dateKey);
  if (previousWeight === undefined) return "maintain";
  const difference = Number((entry.weight - previousWeight).toFixed(1));
  if (difference <= -0.2) return "cut";
  if (difference >= 0.2) return "bulk";
  return "maintain";
}

function getCalendarLabel(mode: CalendarMode, entry: DayEntry) {
  if (mode === "calories") return entry.calories === undefined ? "No log" : `${entry.calories}`;
  if (mode === "protein") return entry.protein === undefined ? "No log" : `${entry.protein}g`;
  return entry.weight === undefined ? "No log" : `${entry.weight.toFixed(1)}kg`;
}

function formatTrend(diff: number | undefined) {
  if (diff === undefined) return "--";
  return `${diff > 0 ? "+" : ""}${diff.toFixed(2)} kg`;
}

export default function App() {
  const [entries, setEntries] = useState<EntriesMap>(() => loadLocalEntries());
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("calories");
  const [saveStatus, setSaveStatus] = useState<"local" | "saving" | "synced" | "error">("local");
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<"journal" | "coach">("journal");
  const [goals, setGoals] = useState<Goals>({
    calories: DEFAULT_CALORIE_TARGET,
    protein: DEFAULT_PROTEIN_TARGET,
  });

  const today = useMemo(() => new Date(), []);
  const todayKey = getLocalDateString(today);
  const [selectedDay, setSelectedDay] = useState(todayKey);
  const [viewMonth, setViewMonth] = useState(getMonthStart(today));

  useEffect(() => {
    let cancelled = false;
    let unsubscribeEntries: (() => void) | undefined;

    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      if (cancelled) return;
      unsubscribeEntries?.();
      unsubscribeEntries = undefined;
      setUser(currentUser);
      setAuthReady(true);

      if (!currentUser) {
        setEntries(loadLocalEntries());
        setSaveStatus("local");
        return;
      }

      setSaveStatus("saving");

      try {
        const snapshot = await getDocs(collection(db, "users", currentUser.uid, "entries"));
        const cloudEntries: EntriesMap = {};

        snapshot.forEach((entryDoc) => {
          const data = entryDoc.data();
          cloudEntries[entryDoc.id] = {
            ...(typeof data.calories === "number" ? { calories: data.calories } : {}),
            ...(typeof data.protein === "number" ? { protein: data.protein } : {}),
            ...(typeof data.weight === "number" ? { weight: data.weight } : {}),
            ...(typeof data.notes === "string" ? { notes: data.notes } : {}),
          };
        });

        const localEntries = {
          ...loadLocalEntries(),
          ...loadLocalEntries(getUserStorageKey(currentUser.uid)),
        };
        const localOnlyEntries = Object.entries(localEntries).filter(([dateKey]) => !cloudEntries[dateKey]);

        await Promise.all(
          localOnlyEntries.map(([dateKey, entry]) =>
            setDoc(doc(db, "users", currentUser.uid, "entries", dateKey), {
              ...cleanEntry(entry),
              updatedAt: serverTimestamp(),
            }),
          ),
        );

        if (cancelled || auth.currentUser?.uid !== currentUser.uid) return;

        const mergedEntries = { ...localEntries, ...cloudEntries };
        setEntries(mergedEntries);
        localStorage.setItem(getUserStorageKey(currentUser.uid), JSON.stringify(mergedEntries));
        localStorage.removeItem(STORAGE_KEY);
        setSaveStatus("synced");

        unsubscribeEntries = onSnapshot(
          collection(db, "users", currentUser.uid, "entries"),
          (liveSnapshot) => {
            const liveEntries: EntriesMap = {};

            liveSnapshot.forEach((entryDoc) => {
              const data = entryDoc.data();
              liveEntries[entryDoc.id] = {
                ...(typeof data.calories === "number" ? { calories: data.calories } : {}),
                ...(typeof data.protein === "number" ? { protein: data.protein } : {}),
                ...(typeof data.weight === "number" ? { weight: data.weight } : {}),
                ...(typeof data.notes === "string" ? { notes: data.notes } : {}),
              };
            });

            setEntries(liveEntries);
            localStorage.setItem(getUserStorageKey(currentUser.uid), JSON.stringify(liveEntries));
            setSaveStatus("synced");
          },
          (error) => {
            console.error("Unable to receive journal updates", error);
            setSaveStatus("error");
          },
        );
      } catch (error) {
        console.error("Unable to sync journal entries", error);
        setSaveStatus("error");
      }
    });

    return () => {
      cancelled = true;
      unsubscribeAuth();
      unsubscribeEntries?.();
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setGoals({ calories: DEFAULT_CALORIE_TARGET, protein: DEFAULT_PROTEIN_TARGET });
      return;
    }

    return onSnapshot(doc(db, "users", user.uid, "settings", "goals"), (snapshot) => {
      const data = snapshot.data();
      setGoals({
        calories: typeof data?.calories === "number" ? data.calories : DEFAULT_CALORIE_TARGET,
        protein: typeof data?.protein === "number" ? data.protein : DEFAULT_PROTEIN_TARGET,
      });
    });
  }, [user]);

  const selectedEntry = getDayEntry(entries, selectedDay);
  const averageWeight = getAverage(entries, selectedDay, 7, "weight");
  const averageCalories = getAverage(entries, selectedDay, 7, "calories");
  const averageProtein = getAverage(entries, selectedDay, 7, "protein");
  const weightTrend = getWeightTrend(entries, selectedDay);
  const isToday = selectedDay === todayKey;

  function saveEntry(dateKey: string, entry: DayEntry) {
    const cleanedEntry = cleanEntry(entry);
    const storageKey = user ? getUserStorageKey(user.uid) : STORAGE_KEY;

    setEntries((previous) => {
      const nextEntries = { ...previous, [dateKey]: cleanedEntry };
      localStorage.setItem(storageKey, JSON.stringify(nextEntries));
      return nextEntries;
    });

    if (!user) {
      setSaveStatus("local");
      return;
    }

    setSaveStatus("saving");
    setDoc(doc(db, "users", user.uid, "entries", dateKey), {
      ...cleanedEntry,
      updatedAt: serverTimestamp(),
    })
      .then(() => setSaveStatus("synced"))
      .catch((error) => {
        console.error("Unable to save journal entry", error);
        setSaveStatus("error");
      });
  }

  function updateSelectedEntry(patch: Partial<DayEntry>) {
    saveEntry(selectedDay, { ...selectedEntry, ...patch });
  }

  function updateNumber(field: "calories" | "protein" | "weight", value: string) {
    if (value === "") {
      updateSelectedEntry({ [field]: undefined });
      return;
    }

    const number = Number(value);
    if (Number.isNaN(number)) return;
    updateSelectedEntry({
      [field]: field === "weight" ? Number(number.toFixed(1)) : Math.max(0, Math.round(number)),
    });
  }

  function clearSelectedDay() {
    const storageKey = user ? getUserStorageKey(user.uid) : STORAGE_KEY;

    setEntries((previous) => {
      const nextEntries = { ...previous };
      delete nextEntries[selectedDay];
      localStorage.setItem(storageKey, JSON.stringify(nextEntries));
      return nextEntries;
    });

    if (!user) {
      setSaveStatus("local");
      return;
    }

    setSaveStatus("saving");
    deleteDoc(doc(db, "users", user.uid, "entries", selectedDay))
      .then(() => setSaveStatus("synced"))
      .catch((error) => {
        console.error("Unable to clear journal entry", error);
        setSaveStatus("error");
      });
  }

  function goToToday() {
    setSelectedDay(todayKey);
    setViewMonth(getMonthStart(today));
  }

  function selectCalendarDay(date: Date) {
    setSelectedDay(getLocalDateString(date));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleSignIn() {
    signInWithPopup(auth, googleProvider).catch((error) => {
      console.error("Unable to sign in with Google", error);
      setSaveStatus("error");
    });
  }

  async function saveGoals(nextGoals: Goals) {
    if (!user) return;
    await setDoc(doc(db, "users", user.uid, "settings", "goals"), {
      calories: Math.max(0, Math.round(nextGoals.calories)),
      protein: Math.max(0, Math.round(nextGoals.protein)),
      updatedAt: serverTimestamp(),
    });
  }

  async function applyCoachProposal(proposal: CoachProposal) {
    if (!user) throw new Error("Sign in before applying Coach updates.");

    if (proposal.type === "goals") {
      if (proposal.calorieTarget === null || proposal.proteinTarget === null) throw new Error("Both goals are required.");
      await saveGoals({ calories: proposal.calorieTarget, protein: proposal.proteinTarget });
      return;
    }

    if (!proposal.date) throw new Error("Choose a date before applying this update.");
    const entryRef = doc(db, "users", user.uid, "entries", proposal.date);
    const mealLogRef = doc(collection(db, "users", user.uid, "mealLogs"));

    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(entryRef);
      const current = snapshot.data() ?? {};

      if (proposal.type === "meal") {
        if (proposal.calories === null || proposal.protein === null) throw new Error("Calories and protein are required.");
        const foodNote = `Food: ${proposal.summary}`;
        const existingNotes = typeof current.notes === "string" ? current.notes.trim() : "";
        const nextNotes = existingNotes.includes(foodNote)
          ? existingNotes
          : [existingNotes, foodNote].filter(Boolean).join("\n").slice(0, 2000);
        transaction.set(entryRef, {
          ...current,
          calories: Math.max(0, Math.round((Number(current.calories) || 0) + proposal.calories)),
          protein: Math.max(0, Math.round((Number(current.protein) || 0) + proposal.protein)),
          notes: nextNotes,
          updatedAt: serverTimestamp(),
        });
        transaction.set(mealLogRef, {
          date: proposal.date,
          summary: proposal.summary,
          calories: Math.max(0, Math.round(proposal.calories)),
          protein: Math.max(0, Math.round(proposal.protein)),
          source: "coach",
          transcript: proposal.summary,
          createdAt: serverTimestamp(),
        });
      } else {
        if (proposal.weight === null) throw new Error("Weight is required.");
        transaction.set(entryRef, {
          ...current,
          weight: Number(proposal.weight.toFixed(1)),
          updatedAt: serverTimestamp(),
        });
      }
    });
  }

  return (
    <main className={`app-shell ${activeTab === "coach" ? "coach-active" : ""}`}>
      <div className="app-layout">
        <header className="app-header">
          <div>
            <p className="eyebrow">Daily nutrition tracker</p>
            <h1>Macro Journal</h1>
          </div>
          <div className="account-controls">
            <div className={`save-status ${saveStatus}`}>
              <span />
              {getSaveStatusLabel(saveStatus)}
            </div>
            {authReady && !user && (
                <button className="account-btn primary" onClick={handleSignIn}>
                  Sign in with Google
                </button>
            )}
          </div>
        </header>

        <nav className="app-tabs" aria-label="Main sections">
          <button className={activeTab === "journal" ? "active" : ""} onClick={() => setActiveTab("journal")}>
            Journal
          </button>
          <button className={activeTab === "coach" ? "active" : ""} onClick={() => setActiveTab("coach")}>
            Coach
          </button>
        </nav>

        {activeTab === "coach" ? (
          user ? (
            <Coach
              user={user}
              entries={entries}
              selectedDate={selectedDay}
              today={todayKey}
              goals={goals}
              onApplyProposal={applyCoachProposal}
            />
          ) : (
            <section className="panel coach-signed-out">
              <p className="eyebrow">AI nutrition coach</p>
              <h2>Sign in to use the Coach</h2>
              <p>The Coach needs your synced journal history to answer questions and propose updates.</p>
              <button className="account-btn primary" onClick={handleSignIn}>Sign in with Google</button>
            </section>
          )
        ) : (
        <>
        <section className="panel entry-panel">
          <div className="section-header">
            <div>
              <p className="eyebrow">{isToday ? "Today" : "Selected day"}</p>
              <h2>{formatLongDate(selectedDay)}</h2>
            </div>
            {!isToday && (
              <button className="text-btn" onClick={goToToday}>
                Back to today
              </button>
            )}
          </div>

          <div className="entry-grid">
            <NumberField
              label="Calories"
              unit="kcal"
              value={selectedEntry.calories}
              placeholder="2100"
              onChange={(value) => updateNumber("calories", value)}
            />
            <NumberField
              label="Protein"
              unit="g"
              value={selectedEntry.protein}
              placeholder="160"
              onChange={(value) => updateNumber("protein", value)}
            />
            <NumberField
              label="Weight"
              unit="kg"
              value={selectedEntry.weight}
              placeholder="83.4"
              step="0.1"
              onChange={(value) => updateNumber("weight", value)}
            />
          </div>

          <details className="notes-details" open={Boolean(selectedEntry.notes)}>
            <summary>
              <span>Notes</span>
              <span className="notes-preview">{selectedEntry.notes ? "Added" : "Optional"}</span>
            </summary>
            <textarea
              value={selectedEntry.notes ?? ""}
              onChange={(event) => updateSelectedEntry({ notes: event.target.value })}
              placeholder="Training, sleep, meals, or anything worth remembering."
            />
          </details>

          <div className="entry-footer">
            <p>{user ? `Syncing as ${user.email ?? "your Google account"}.` : "Sign in to sync across devices."}</p>
            <button className="danger-btn" onClick={clearSelectedDay}>
              Clear entry
            </button>
          </div>
        </section>

        <section className="panel goals-panel">
          <div>
            <p className="eyebrow">Targets</p>
            <h2>Daily goals</h2>
          </div>
          <div className="goal-inputs">
            <NumberField
              label="Calories"
              unit="kcal"
              value={goals.calories}
              placeholder="2100"
              onChange={(value) => {
                if (value) void saveGoals({ ...goals, calories: Number(value) });
              }}
            />
            <NumberField
              label="Protein"
              unit="g"
              value={goals.protein}
              placeholder="160"
              onChange={(value) => {
                if (value) void saveGoals({ ...goals, protein: Number(value) });
              }}
            />
          </div>
        </section>

        <section className="stats-strip" aria-label="Seven day averages">
          <Stat label="Weight avg" value={averageWeight === undefined ? "--" : `${averageWeight.toFixed(1)} kg`} />
          <Stat label="Calorie avg" value={averageCalories === undefined ? "--" : `${Math.round(averageCalories)}`} />
          <Stat label="Protein avg" value={averageProtein === undefined ? "--" : `${Math.round(averageProtein)}g`} />
          <Stat label={weightTrend.label} value={formatTrend(weightTrend.diff)} tone={weightTrend.tone} />
        </section>

        <section className="panel calendar-panel">
          <div className="section-header calendar-heading">
            <div>
              <p className="eyebrow">History</p>
              <h2>{formatMonthYear(viewMonth)}</h2>
            </div>
            <div className="month-nav">
              <button aria-label="Previous month" onClick={() => setViewMonth(addMonths(viewMonth, -1))}>
                Prev
              </button>
              <button onClick={goToToday}>Today</button>
              <button aria-label="Next month" onClick={() => setViewMonth(addMonths(viewMonth, 1))}>
                Next
              </button>
            </div>
          </div>

          <div className="mode-switcher">
            {(["calories", "protein", "weight"] as CalendarMode[]).map((mode) => (
              <button
                key={mode}
                className={calendarMode === mode ? "active" : ""}
                onClick={() => setCalendarMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="calendar-grid">
            {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
              <div key={`${day}-${index}`} className="weekday-label">
                {day}
              </div>
            ))}

            {getMonthGrid(viewMonth).map((date, index) => {
              if (!date) return <div key={`empty-${index}`} className="calendar-spacer" />;
              const dateKey = getLocalDateString(date);
              const entry = getDayEntry(entries, dateKey);
              const tone = getCalendarTone(calendarMode, entry, entries, dateKey, goals);

              return (
                <button
                  key={dateKey}
                  onClick={() => selectCalendarDay(date)}
                  className={`calendar-day ${toneClass(tone)} ${dateKey === selectedDay ? "selected" : ""} ${dateKey === todayKey ? "today" : ""}`}
                  title={formatLongDate(dateKey)}
                >
                  <span>{date.getDate()}</span>
                  <strong>{getCalendarLabel(calendarMode, entry)}</strong>
                </button>
              );
            })}
          </div>

          <div className="legend">
            <span><i className="cut-dot" />Cut / target</span>
            <span><i className="maintain-dot" />Maintain</span>
            <span><i className="bulk-dot" />Bulk / below target</span>
          </div>
        </section>
        </>
        )}
      </div>
    </main>
  );
}

function NumberField({
  label,
  unit,
  value,
  placeholder,
  step = "1",
  onChange,
}: {
  label: string;
  unit: string;
  value: number | undefined;
  placeholder: string;
  step?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <b>{unit}</b>
      </div>
    </label>
  );
}

function Stat({
  label,
  value,
  tone = "empty",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`stat ${toneClass(tone)}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
