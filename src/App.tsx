import { useEffect, useMemo, useState } from "react";
import "./App.css";

type DayEntry = {
  calories?: number;
  protein?: number;
  weight?: number;
  notes?: string;
};

type EntriesMap = Record<string, DayEntry>;
type CalendarMode = "calories" | "protein" | "weight";
type QuickField = "calories" | "protein" | "weight";

const DEFAULT_CALORIE_TARGET = 2100;
const DEFAULT_PROTEIN_TARGET = 160;

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

function isSameMonth(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function getWeekdayHeaders() {
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
}

function getMonthGrid(viewMonth: Date) {
  const start = getMonthStart(viewMonth);
  const end = getMonthEnd(viewMonth);

  const jsDay = start.getDay();
  const mondayIndex = jsDay === 0 ? 6 : jsDay - 1;

  const grid: (Date | null)[] = [];

  for (let i = 0; i < mondayIndex; i++) {
    grid.push(null);
  }

  for (let day = 1; day <= end.getDate(); day++) {
    grid.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day));
  }

  while (grid.length % 7 !== 0) {
    grid.push(null);
  }

  return grid;
}

function getDayEntry(entries: EntriesMap, dateKey: string): DayEntry {
  return entries[dateKey] ?? {};
}

function getAverageWeight(entries: EntriesMap, endDateKey: string, days: number) {
  const endDate = parseDateKey(endDateKey);
  const values: number[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - i);
    const key = getLocalDateString(date);
    const weight = entries[key]?.weight;

    if (typeof weight === "number" && !Number.isNaN(weight)) {
      values.push(weight);
    }
  }

  if (values.length === 0) return undefined;

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function getAverageNumber(entries: EntriesMap, endDateKey: string, days: number, field: "calories" | "protein") {
  const endDate = parseDateKey(endDateKey);
  const values: number[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - i);
    const key = getLocalDateString(date);
    const value = entries[key]?.[field];

    if (typeof value === "number" && !Number.isNaN(value)) {
      values.push(value);
    }
  }

  if (values.length === 0) return undefined;

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function getWeightTrend(entries: EntriesMap, endDateKey: string) {
  const currentAvg = getAverageWeight(entries, endDateKey, 7);

  const earlierEnd = parseDateKey(endDateKey);
  earlierEnd.setDate(earlierEnd.getDate() - 7);
  const earlierAvg = getAverageWeight(entries, getLocalDateString(earlierEnd), 7);

  if (currentAvg === undefined || earlierAvg === undefined) {
    return {
      diff: undefined as number | undefined,
      label: "Need more logs",
      description: "Log weight across at least two weeks to see a real trend",
      tone: "empty",
    };
  }

  const diff = Number((currentAvg - earlierAvg).toFixed(2));
  const absDiff = Math.abs(diff);

  if (absDiff < 0.15) {
    return {
      diff,
      label: "Stable",
      description: `${diff > 0 ? "+" : ""}${diff.toFixed(2)} kg vs previous 7 day average`,
      tone: "maintain",
    };
  }

  return {
    diff,
    label: diff > 0 ? "Trending up" : "Trending down",
    description: `${diff > 0 ? "+" : ""}${diff.toFixed(2)} kg vs previous 7 day average`,
    tone: diff > 0 ? "bulk" : "cut",
  };
}

function formatWeight(value: number | undefined) {
  if (value === undefined) return "—";
  return `${value.toFixed(1)} kg`;
}

function toneClass(tone: string) {
  if (tone === "cut") return "tone-cut";
  if (tone === "bulk") return "tone-bulk";
  if (tone === "maintain") return "tone-maintain";
  return "tone-empty";
}

function getCalorieTone(calories: number | undefined, calorieTarget: number) {
  if (calories === undefined) return "empty";

  const cutThreshold = calorieTarget - 150;
  const bulkThreshold = calorieTarget + 150;

  if (calories <= cutThreshold) return "cut";
  if (calories >= bulkThreshold) return "bulk";
  return "maintain";
}

function getProteinTone(protein: number | undefined, proteinTarget: number) {
  if (protein === undefined) return "empty";

  if (protein >= proteinTarget) return "cut";
  if (protein >= proteinTarget * 0.8) return "maintain";
  return "bulk";
}

function getPreviousLoggedWeight(entries: EntriesMap, dateKey: string) {
  const base = parseDateKey(dateKey);

  for (let i = 1; i <= 30; i++) {
    const prev = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    const key = getLocalDateString(prev);
    const weight = entries[key]?.weight;

    if (typeof weight === "number" && !Number.isNaN(weight)) {
      return weight;
    }
  }

  return undefined;
}

function getWeightTone(weight: number | undefined, previousWeight: number | undefined) {
  if (weight === undefined) return "empty";
  if (previousWeight === undefined) return "maintain";

  const diff = Number((weight - previousWeight).toFixed(1));

  if (diff <= -0.2) return "cut";
  if (diff >= 0.2) return "bulk";
  return "maintain";
}

function getCalendarTone(
  mode: CalendarMode,
  entry: DayEntry,
  calorieTarget: number,
  proteinTarget: number,
  entries: EntriesMap,
  dateKey: string
) {
  if (mode === "calories") {
    return getCalorieTone(entry.calories, calorieTarget);
  }

  if (mode === "protein") {
    return getProteinTone(entry.protein, proteinTarget);
  }

  return getWeightTone(entry.weight, getPreviousLoggedWeight(entries, dateKey));
}

function getCalendarLabel(mode: CalendarMode, entry: DayEntry) {
  if (mode === "calories") {
    return entry.calories === undefined ? "No log" : `${entry.calories} kcal`;
  }

  if (mode === "protein") {
    return entry.protein === undefined ? "No log" : `${entry.protein} g`;
  }

  return entry.weight === undefined ? "No log" : `${entry.weight.toFixed(1)} kg`;
}

export default function App() {
  const [entries, setEntries] = useState<EntriesMap>(() => {
    const saved = localStorage.getItem("macro-journal-v2-entries");
    return saved ? JSON.parse(saved) : {};
  });

  const [calendarMode, setCalendarMode] = useState<CalendarMode>("calories");

  const today = useMemo(() => new Date(), []);
  const todayKey = getLocalDateString(today);

  const [selectedDay, setSelectedDay] = useState<string>(todayKey);
  const [viewMonth, setViewMonth] = useState<Date>(getMonthStart(today));

  const [quickField, setQuickField] = useState<QuickField | null>(null);
  const [quickValue, setQuickValue] = useState("");

  useEffect(() => {
    localStorage.setItem("macro-journal-v2-entries", JSON.stringify(entries));
  }, [entries]);

  const selectedEntry = getDayEntry(entries, selectedDay);

  const sevenDayAverageWeight = getAverageWeight(entries, selectedDay, 7);
  const sevenDayAverageCalories = getAverageNumber(entries, selectedDay, 7, "calories");
  const sevenDayAverageProtein = getAverageNumber(entries, selectedDay, 7, "protein");
  const weightTrend = getWeightTrend(entries, selectedDay);

  const monthGrid = getMonthGrid(viewMonth);

  function updateSelectedEntry(patch: Partial<DayEntry>) {
    setEntries((prev) => ({
      ...prev,
      [selectedDay]: {
        ...getDayEntry(prev, selectedDay),
        ...patch,
      },
    }));
  }

  function clearSelectedDay() {
    setEntries((prev) => ({
      ...prev,
      [selectedDay]: {
        notes: "",
      },
    }));
  }

  function openQuickModal(field: QuickField) {
    const currentValue = selectedEntry[field];
    setQuickField(field);
    setQuickValue(
      typeof currentValue === "number" && !Number.isNaN(currentValue) ? String(currentValue) : ""
    );
  }

  function closeQuickModal() {
    setQuickField(null);
    setQuickValue("");
  }

  function saveQuickModal() {
    if (!quickField) return;

    const raw = Number(quickValue);

    if (quickValue.trim() === "" || Number.isNaN(raw)) {
      updateSelectedEntry({ [quickField]: undefined });
      closeQuickModal();
      return;
    }

    const cleanValue = quickField === "weight" ? Number(raw.toFixed(1)) : Math.max(0, Math.round(raw));
    updateSelectedEntry({ [quickField]: cleanValue });
    closeQuickModal();
  }

  function goToToday() {
    setSelectedDay(todayKey);
    setViewMonth(getMonthStart(today));
  }

  function selectCalendarDay(date: Date) {
    const key = getLocalDateString(date);
    setSelectedDay(key);

    if (!isSameMonth(viewMonth, date)) {
      setViewMonth(getMonthStart(date));
    }
  }

  return (
    <div className="app-shell">
      <div className="app-layout">
        <section className="panel hero-panel">
          <div className="hero-header">
            <div>
              <h1 className="app-title">Macro Journal</h1>
              <p className="app-subtitle">
                Log one clean set of numbers each day, track your weekly averages, and click any day
                in the calendar to edit it later.
              </p>
            </div>
          </div>

          <div className="quick-actions-grid">
            <button className="primary-btn" onClick={() => openQuickModal("calories")}>
              Add calories
            </button>
            <button className="primary-btn" onClick={() => openQuickModal("protein")}>
              Add protein
            </button>
            <button className="primary-btn" onClick={() => openQuickModal("weight")}>
              Add weight
            </button>
          </div>

          <div className="summary-grid">
            <SummaryCard
              title="7 day average weight"
              value={formatWeight(sevenDayAverageWeight)}
              subtitle="Best signal for real progress"
            />
            <SummaryCard
              title="7 day calorie average"
              value={sevenDayAverageCalories === undefined ? "—" : `${Math.round(sevenDayAverageCalories)} kcal`}
              subtitle="Average across logged days"
            />
            <SummaryCard
              title="7 day protein average"
              value={sevenDayAverageProtein === undefined ? "—" : `${Math.round(sevenDayAverageProtein)} g`}
              subtitle="Average across logged days"
            />
            <SummaryCard
              title="Weight trend"
              value={weightTrend.diff === undefined ? "—" : `${weightTrend.diff > 0 ? "+" : ""}${weightTrend.diff.toFixed(2)} kg`}
              subtitle={weightTrend.description}
              tone={weightTrend.tone}
            />
          </div>
        </section>

        <section className="panel calendar-panel">
          <div className="calendar-header">
            <div>
              <h2 className="section-title">{formatMonthYear(viewMonth)}</h2>
              <p className="section-subtitle">
                Green = cutting zone, yellow = maintenance zone, red = bulking zone.
              </p>
            </div>

            <div className="calendar-controls">
              <button
                className={`calendar-mode-btn ${calendarMode === "calories" ? "active" : ""}`}
                onClick={() => setCalendarMode("calories")}
              >
                Calories
              </button>
              <button
                className={`calendar-mode-btn ${calendarMode === "protein" ? "active" : ""}`}
                onClick={() => setCalendarMode("protein")}
              >
                Protein
              </button>
              <button
                className={`calendar-mode-btn ${calendarMode === "weight" ? "active" : ""}`}
                onClick={() => setCalendarMode("weight")}
              >
                Weight
              </button>
            </div>
          </div>

          <div className="calendar-topbar">
            <div className="month-nav">
              <button className="secondary-btn" onClick={() => setViewMonth(addMonths(viewMonth, -1))}>
                Previous
              </button>
              <button className="secondary-btn" onClick={goToToday}>
                Today
              </button>
              <button className="secondary-btn" onClick={() => setViewMonth(addMonths(viewMonth, 1))}>
                Next
              </button>
            </div>
          </div>

          <div className="calendar-grid">
            {getWeekdayHeaders().map((day) => (
              <div key={day} className="weekday-label">
                {day}
              </div>
            ))}

            {monthGrid.map((date, index) => {
              if (!date) {
                return <div key={`empty-${index}`} className="calendar-spacer" />;
              }

              const dateKey = getLocalDateString(date);
              const entry = getDayEntry(entries, dateKey);
              const tone = getCalendarTone(
                calendarMode,
                entry,
                DEFAULT_CALORIE_TARGET,
                DEFAULT_PROTEIN_TARGET,
                entries,
                dateKey
              );

              const isSelected = dateKey === selectedDay;
              const isToday = dateKey === todayKey;

              return (
                <button
                  key={dateKey}
                  onClick={() => selectCalendarDay(date)}
                  className={`calendar-day ${toneClass(tone)} ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
                  title={`${formatLongDate(dateKey)}`}
                >
                  <div className="calendar-day-number">{date.getDate()}</div>
                  <div className="calendar-day-footer">
                    <div className="calendar-day-value">{getCalendarLabel(calendarMode, entry)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel editor-panel">
          <div className="editor-header">
            <div>
              <h2 className="section-title">Edit selected day</h2>
              <p className="section-subtitle">{formatLongDate(selectedDay)}</p>
            </div>

            <button className="danger-btn" onClick={clearSelectedDay}>
              Clear numbers
            </button>
          </div>

          <div className="editor-grid">
            <label className="field-group">
              <span className="field-label">Calories</span>
              <input
                className="text-input"
                type="number"
                value={selectedEntry.calories ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  updateSelectedEntry({
                    calories: value === "" ? undefined : Math.max(0, Math.round(Number(value) || 0)),
                  });
                }}
                placeholder="e.g. 2150"
              />
            </label>

            <label className="field-group">
              <span className="field-label">Protein (g)</span>
              <input
                className="text-input"
                type="number"
                value={selectedEntry.protein ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  updateSelectedEntry({
                    protein: value === "" ? undefined : Math.max(0, Math.round(Number(value) || 0)),
                  });
                }}
                placeholder="e.g. 180"
              />
            </label>

            <label className="field-group">
              <span className="field-label">Weight (kg)</span>
              <input
                className="text-input"
                type="number"
                step="0.1"
                value={selectedEntry.weight ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  updateSelectedEntry({
                    weight: value === "" ? undefined : Number((Number(value) || 0).toFixed(1)),
                  });
                }}
                placeholder="e.g. 83.4"
              />
            </label>

            <div className={`editor-stat-card ${toneClass(weightTrend.tone)}`}>
              <div className="editor-stat-title">Weight trend</div>
              <div className="editor-stat-value">
                {weightTrend.diff === undefined ? "—" : `${weightTrend.diff > 0 ? "+" : ""}${weightTrend.diff.toFixed(2)} kg`}
              </div>
              <div className="editor-stat-subtitle">{weightTrend.description}</div>
            </div>
          </div>

          <label className="field-group notes-group">
            <span className="field-label">Notes</span>
            <textarea
              className="text-area"
              value={selectedEntry.notes ?? ""}
              onChange={(e) => updateSelectedEntry({ notes: e.target.value })}
              placeholder="Optional notes. Tennis day, takeaway, low sleep, anything useful."
            />
          </label>
        </section>
      </div>

      {quickField && (
        <div className="modal-overlay" onClick={closeQuickModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {quickField === "calories"
                  ? "Add calories"
                  : quickField === "protein"
                  ? "Add protein"
                  : "Add weight"}
              </h3>
              <p className="modal-subtitle">{formatLongDate(selectedDay)}</p>
            </div>

            <div className="modal-fields">
              <label className="field-group">
                <span className="field-label">
                  {quickField === "calories"
                    ? "Calories"
                    : quickField === "protein"
                    ? "Protein (g)"
                    : "Weight (kg)"}
                </span>
                <input
                  className="text-input"
                  type="number"
                  step={quickField === "weight" ? "0.1" : "1"}
                  value={quickValue}
                  onChange={(e) => setQuickValue(e.target.value)}
                  placeholder={quickField === "weight" ? "0.0" : "0"}
                  autoFocus
                />
              </label>
            </div>

            <div className="modal-actions">
              <button className="secondary-btn" onClick={closeQuickModal}>
                Cancel
              </button>
              <button className="primary-btn" onClick={saveQuickModal}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  title,
  value,
  subtitle,
  tone,
}: {
  title: string;
  value: string;
  subtitle: string;
  tone?: string;
}) {
  return (
    <div className={`summary-card ${tone ? toneClass(tone) : ""}`}>
      <div className="summary-card-title">{title}</div>
      <div className="summary-card-value">{value}</div>
      <div className="summary-card-subtitle">{subtitle}</div>
    </div>
  );
}