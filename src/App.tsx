import React, { useEffect, useMemo, useState } from "react";
import "./App.css";

type Meal = {
  id: string;
  name: string;
  calories: number;
  protein: number;
};

type DayEntry = {
  meals: Meal[];
};

type EntriesMap = Record<string, DayEntry>;
type CalendarMode = "calories" | "protein";

const MAX_MEALS_PER_DAY = 5;
const DEFAULT_CALORIE_TARGET = 1800;
const DEFAULT_PROTEIN_TARGET = 160;

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

function formatShortDate(dateKey: string) {
  return parseDateKey(dateKey).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
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

function getMealsForDay(entries: EntriesMap, dateKey: string): Meal[] {
  return entries[dateKey]?.meals ?? [];
}

function getDayTotals(entries: EntriesMap, dateKey: string) {
  const meals = getMealsForDay(entries, dateKey);
  const calories = meals.reduce((sum, meal) => sum + (meal.calories || 0), 0);
  const protein = meals.reduce((sum, meal) => sum + (meal.protein || 0), 0);

  return {
    calories,
    protein,
    mealsCount: meals.length,
  };
}

function getCalorieStatus(totalCalories: number, calorieTarget: number, mealsCount: number) {
  if (mealsCount === 0) {
    return {
      tone: "empty",
      label: "No log",
      description: "No meals logged",
    };
  }

  const diff = totalCalories - calorieTarget;

  if (diff <= -150) {
    return {
      tone: "good",
      label: "Deficit",
      description: `${Math.abs(diff)} kcal under target`,
    };
  }

  if (diff >= 150) {
    return {
      tone: "bad",
      label: "Surplus",
      description: `${diff} kcal over target`,
    };
  }

  return {
    tone: "close",
    label: "Near target",
    description: `${Math.abs(diff)} kcal from target`,
  };
}

function getProteinStatus(totalProtein: number, proteinTarget: number, mealsCount: number) {
  if (mealsCount === 0) {
    return {
      tone: "empty",
      label: "No log",
      description: "No meals logged",
    };
  }

  const ratio = proteinTarget > 0 ? totalProtein / proteinTarget : 0;

  if (ratio >= 1) {
    return {
      tone: "good",
      label: "Hit goal",
      description: `${totalProtein} / ${proteinTarget} g`,
    };
  }

  if (ratio >= 0.8) {
    return {
      tone: "close",
      label: "Close",
      description: `${proteinTarget - totalProtein} g short`,
    };
  }

  return {
    tone: "bad",
    label: "Missed",
    description: `${proteinTarget - totalProtein} g short`,
  };
}

function getCalendarStatus(
  mode: CalendarMode,
  totals: { calories: number; protein: number; mealsCount: number },
  calorieTarget: number,
  proteinTarget: number
) {
  return mode === "calories"
    ? getCalorieStatus(totals.calories, calorieTarget, totals.mealsCount)
    : getProteinStatus(totals.protein, proteinTarget, totals.mealsCount);
}

function getCurrentDeficitStreak(entries: EntriesMap, calorieTarget: number) {
  const today = new Date();
  let streak = 0;

  for (let i = 0; i < 365; i++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = getLocalDateString(date);
    const totals = getDayTotals(entries, key);
    const status = getCalorieStatus(totals.calories, calorieTarget, totals.mealsCount);

    if (status.tone === "good") {
      streak += 1;
    } else {
      break;
    }
  }

  return streak;
}

function getWindowSummary(entries: EntriesMap, calorieTarget: number, proteinTarget: number, days: number) {
  const today = new Date();

  let loggedDays = 0;
  let deficitDays = 0;
  let proteinHitDays = 0;

  for (let i = 0; i < days; i++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = getLocalDateString(date);
    const totals = getDayTotals(entries, key);

    if (totals.mealsCount === 0) continue;

    loggedDays += 1;

    const calorieStatus = getCalorieStatus(totals.calories, calorieTarget, totals.mealsCount);
    const proteinStatus = getProteinStatus(totals.protein, proteinTarget, totals.mealsCount);

    if (calorieStatus.tone === "good") deficitDays += 1;
    if (proteinStatus.tone === "good") proteinHitDays += 1;
  }

  return {
    loggedDays,
    deficitDays,
    proteinHitDays,
    calorieCompliance: loggedDays === 0 ? 0 : Math.round((deficitDays / loggedDays) * 100),
    proteinCompliance: loggedDays === 0 ? 0 : Math.round((proteinHitDays / loggedDays) * 100),
  };
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

function toneClass(tone: string) {
  if (tone === "good") return "tone-good";
  if (tone === "bad") return "tone-bad";
  if (tone === "close") return "tone-close";
  return "tone-empty";
}

export default function App() {
  const [entries, setEntries] = useState<EntriesMap>(() => {
    const saved = localStorage.getItem("macro-journal-clean-entries");
    return saved ? JSON.parse(saved) : {};
  });

  const [calorieTarget, setCalorieTarget] = useState<number>(() => {
    const saved = localStorage.getItem("macro-journal-clean-calorie-target");
    return saved ? Number(saved) : DEFAULT_CALORIE_TARGET;
  });

  const [proteinTarget, setProteinTarget] = useState<number>(() => {
    const saved = localStorage.getItem("macro-journal-clean-protein-target");
    return saved ? Number(saved) : DEFAULT_PROTEIN_TARGET;
  });

  const [calendarMode, setCalendarMode] = useState<CalendarMode>("calories");

  const today = useMemo(() => new Date(), []);
  const todayKey = getLocalDateString(today);

  const [selectedDay, setSelectedDay] = useState<string>(todayKey);
  const [viewMonth, setViewMonth] = useState<Date>(getMonthStart(today));

  const [isMealModalOpen, setIsMealModalOpen] = useState(false);
  const [editingMealId, setEditingMealId] = useState<string | null>(null);
  const [mealDraft, setMealDraft] = useState({
    name: "",
    calories: "",
    protein: "",
  });

  useEffect(() => {
    localStorage.setItem("macro-journal-clean-entries", JSON.stringify(entries));
  }, [entries]);

  useEffect(() => {
    localStorage.setItem("macro-journal-clean-calorie-target", String(calorieTarget));
  }, [calorieTarget]);

  useEffect(() => {
    localStorage.setItem("macro-journal-clean-protein-target", String(proteinTarget));
  }, [proteinTarget]);

  const selectedEntry = entries[selectedDay] ?? { meals: [] };
  const selectedTotals = getDayTotals(entries, selectedDay);

  const calorieStatus = getCalorieStatus(
    selectedTotals.calories,
    calorieTarget,
    selectedTotals.mealsCount
  );

  const proteinStatus = getProteinStatus(
    selectedTotals.protein,
    proteinTarget,
    selectedTotals.mealsCount
  );

  const caloriesRemaining = Math.max(calorieTarget - selectedTotals.calories, 0);
  const caloriesOver = Math.max(selectedTotals.calories - calorieTarget, 0);
  const proteinRemaining = Math.max(proteinTarget - selectedTotals.protein, 0);
  const proteinProgress =
    proteinTarget > 0 ? Math.min((selectedTotals.protein / proteinTarget) * 100, 100) : 0;

  const deficitStreak = getCurrentDeficitStreak(entries, calorieTarget);
  const summary7 = getWindowSummary(entries, calorieTarget, proteinTarget, 7);
  const summary14 = getWindowSummary(entries, calorieTarget, proteinTarget, 14);

  const monthGrid = getMonthGrid(viewMonth);

  function openAddMealModal() {
    if (selectedEntry.meals.length >= MAX_MEALS_PER_DAY) return;

    setEditingMealId(null);
    setMealDraft({
      name: "",
      calories: "",
      protein: "",
    });
    setIsMealModalOpen(true);
  }

  function openEditMealModal(meal: Meal) {
    setEditingMealId(meal.id);
    setMealDraft({
      name: meal.name,
      calories: String(meal.calories),
      protein: String(meal.protein),
    });
    setIsMealModalOpen(true);
  }

  function closeMealModal() {
    setIsMealModalOpen(false);
    setEditingMealId(null);
    setMealDraft({
      name: "",
      calories: "",
      protein: "",
    });
  }

  function saveMealFromModal() {
    const cleanName = mealDraft.name.trim();
    const cleanCalories = Math.max(0, Number(mealDraft.calories) || 0);
    const cleanProtein = Math.max(0, Number(mealDraft.protein) || 0);

    if (!cleanName && cleanCalories === 0 && cleanProtein === 0) {
      closeMealModal();
      return;
    }

    setEntries((prev) => {
      const day = prev[selectedDay] ?? { meals: [] };

      if (editingMealId) {
        return {
          ...prev,
          [selectedDay]: {
            meals: day.meals.map((meal) =>
              meal.id === editingMealId
                ? {
                    ...meal,
                    name: cleanName,
                    calories: cleanCalories,
                    protein: cleanProtein,
                  }
                : meal
            ),
          },
        };
      }

      if (day.meals.length >= MAX_MEALS_PER_DAY) {
        return prev;
      }

      return {
        ...prev,
        [selectedDay]: {
          meals: [
            ...day.meals,
            {
              id: makeId(),
              name: cleanName,
              calories: cleanCalories,
              protein: cleanProtein,
            },
          ],
        },
      };
    });

    closeMealModal();
  }

  function deleteMeal(mealId: string) {
    setEntries((prev) => {
      const day = prev[selectedDay] ?? { meals: [] };

      return {
        ...prev,
        [selectedDay]: {
          meals: day.meals.filter((meal) => meal.id !== mealId),
        },
      };
    });
  }

  function clearDay() {
    setEntries((prev) => ({
      ...prev,
      [selectedDay]: {
        meals: [],
      },
    }));
  }

  function copyPreviousDay() {
    const previousDate = new Date(parseDateKey(selectedDay));
    previousDate.setDate(previousDate.getDate() - 1);
    const previousKey = getLocalDateString(previousDate);

    const previousMeals = entries[previousKey]?.meals ?? [];
    if (previousMeals.length === 0) return;

    setEntries((prev) => ({
      ...prev,
      [selectedDay]: {
        meals: previousMeals.slice(0, MAX_MEALS_PER_DAY).map((meal) => ({
          ...meal,
          id: makeId(),
        })),
      },
    }));
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
        <div className="left-column">
          <section className="panel hero-panel">
            <div className="hero-header">
              <div>
                <h1 className="app-title">Macro Journal</h1>
                <p className="app-subtitle">
                  Track your cut, spot your trends, and keep protein high without doing the maths in
                  your head.
                </p>
              </div>

              <div className="hero-pills">
                <div className="info-pill">{calorieTarget} kcal target</div>
                <div className="info-pill">{proteinTarget} g protein</div>
              </div>
            </div>

            <div className="summary-grid">
              <SummaryCard
                title="Deficit streak"
                value={`${deficitStreak} day${deficitStreak === 1 ? "" : "s"}`}
                subtitle="Current calorie deficit streak"
              />
              <SummaryCard
                title="7 day calorie compliance"
                value={`${summary7.calorieCompliance}%`}
                subtitle={`${summary7.deficitDays} good days from ${summary7.loggedDays} logged`}
              />
              <SummaryCard
                title="14 day protein compliance"
                value={`${summary14.proteinCompliance}%`}
                subtitle={`${summary14.proteinHitDays} protein-hit days from ${summary14.loggedDays} logged`}
              />
            </div>
          </section>

          <section className="panel calendar-panel">
            <div className="calendar-header">
              <div>
                <h2 className="section-title">{formatMonthYear(viewMonth)}</h2>
                <p className="section-subtitle">
                  {calendarMode === "calories"
                    ? "View your calorie consistency day by day."
                    : "View your protein goal consistency day by day."}
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
              </div>
            </div>

            <div className="calendar-topbar">
              <div className="calendar-legend">
                <LegendItem label="Good" tone="good" />
                <LegendItem label="Close" tone="close" />
                <LegendItem label="Bad" tone="bad" />
                <LegendItem label="No log" tone="empty" />
              </div>

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
                const totals = getDayTotals(entries, dateKey);
                const status = getCalendarStatus(calendarMode, totals, calorieTarget, proteinTarget);

                const isSelected = dateKey === selectedDay;
                const isToday = dateKey === todayKey;

                return (
                  <button
                    key={dateKey}
                    onClick={() => selectCalendarDay(date)}
                    className={`calendar-day ${toneClass(status.tone)} ${
                      isSelected ? "selected" : ""
                    } ${isToday ? "today" : ""}`}
                    title={`${formatLongDate(dateKey)} • ${status.label}`}
                  >
                    <div className="calendar-day-number">{date.getDate()}</div>
                    <div className="calendar-day-footer">
                      <div className="calendar-day-label">{status.label}</div>
                      <div className="calendar-day-value">
                        {totals.mealsCount === 0
                          ? "No meals"
                          : calendarMode === "calories"
                          ? `${totals.calories} kcal`
                          : `${totals.protein} g`}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <div className="right-column">
          <section className="panel today-panel">
            <div className="today-header">
              <div>
                <h2 className="section-title">{selectedDay === todayKey ? "Today" : formatShortDate(selectedDay)}</h2>
                <p className="section-subtitle">{formatLongDate(selectedDay)}</p>
              </div>

              <div className={`status-badge ${toneClass(calendarMode === "calories" ? calorieStatus.tone : proteinStatus.tone)}`}>
                {calendarMode === "calories" ? calorieStatus.label : proteinStatus.label}
              </div>
            </div>

            <div className="today-metrics-grid">
              <MetricCard
                title="Calories eaten"
                value={`${selectedTotals.calories} kcal`}
                subtitle={`Target: ${calorieTarget} kcal`}
                tone={calorieStatus.tone}
              />
              <MetricCard
                title="Calories remaining"
                value={
                  selectedTotals.calories <= calorieTarget
                    ? `${caloriesRemaining} kcal`
                    : `-${caloriesOver} kcal`
                }
                subtitle={
                  selectedTotals.calories <= calorieTarget ? "Still within target" : "You are over target"
                }
                tone={selectedTotals.calories <= calorieTarget ? "good" : "bad"}
              />
              <MetricCard
                title="Protein eaten"
                value={`${selectedTotals.protein} g`}
                subtitle={`Target: ${proteinTarget} g`}
                tone={proteinStatus.tone}
              />
              <MetricCard
                title="Protein remaining"
                value={selectedTotals.protein >= proteinTarget ? "0 g" : `${proteinRemaining} g`}
                subtitle={
                  selectedTotals.protein >= proteinTarget ? "Goal hit" : "Still to go"
                }
                tone={selectedTotals.protein >= proteinTarget ? "good" : "close"}
              />
            </div>

            <div className="today-status-row">
              <div className={`status-card ${toneClass(calorieStatus.tone)}`}>
                <div className="status-card-title">Calories</div>
                <div className="status-card-value">{calorieStatus.label}</div>
                <div className="status-card-text">{calorieStatus.description}</div>
              </div>

              <div className={`status-card ${toneClass(proteinStatus.tone)}`}>
                <div className="status-card-title">Protein</div>
                <div className="status-card-value">{proteinStatus.label}</div>
                <div className="status-card-text">{proteinStatus.description}</div>
              </div>
            </div>

            <div className="protein-progress-card">
              <div className="protein-progress-header">
                <span className="protein-progress-title">Protein progress</span>
                <span className="protein-progress-value">
                  {selectedTotals.protein} / {proteinTarget} g
                </span>
              </div>

              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${proteinProgress}%` }}
                />
              </div>
            </div>

            <div className="targets-grid">
              <label className="field-group">
                <span className="field-label">Calorie target</span>
                <input
                  className="text-input"
                  type="number"
                  value={calorieTarget}
                  onChange={(e) => setCalorieTarget(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>

              <label className="field-group">
                <span className="field-label">Protein target</span>
                <input
                  className="text-input"
                  type="number"
                  value={proteinTarget}
                  onChange={(e) => setProteinTarget(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
            </div>

            <div className="today-actions">
              <button
                className="primary-btn"
                onClick={openAddMealModal}
                disabled={selectedEntry.meals.length >= MAX_MEALS_PER_DAY}
              >
                Add meal
              </button>

              <button className="secondary-btn" onClick={copyPreviousDay}>
                Copy previous day
              </button>

              <button className="danger-btn" onClick={clearDay}>
                Clear day
              </button>
            </div>
          </section>

          <section className="panel meals-panel">
            <div className="meals-header">
              <div>
                <h2 className="section-title">Meals</h2>
                <p className="section-subtitle">
                  Simple meal log. Tap a meal to edit it.
                </p>
              </div>

              <div className="meals-cap">
                {selectedEntry.meals.length} logged
              </div>
            </div>

            <div className="meals-list">
              {selectedEntry.meals.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-title">No meals logged yet</div>
                  <p className="empty-state-text">
                    Press Add meal to log your first meal for this day.
                  </p>
                </div>
              ) : (
                selectedEntry.meals.map((meal, index) => (
                  <div key={meal.id} className="meal-item">
                    <div className="meal-item-main">
                      <div className="meal-item-index">Meal {index + 1}</div>
                      <div className="meal-item-name">{meal.name || "Untitled meal"}</div>
                      <div className="meal-item-macros">
                        {meal.calories} kcal • {meal.protein} g protein
                      </div>
                    </div>

                    <div className="meal-item-actions">
                      <button className="secondary-btn" onClick={() => openEditMealModal(meal)}>
                        Edit
                      </button>
                      <button className="danger-btn" onClick={() => deleteMeal(meal.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      {isMealModalOpen && (
        <div className="modal-overlay" onClick={closeMealModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">{editingMealId ? "Edit meal" : "Add meal"}</h3>
                <p className="modal-subtitle">{formatLongDate(selectedDay)}</p>
              </div>
            </div>

            <div className="modal-fields">
              <label className="field-group">
                <span className="field-label">Meal name</span>
                <input
                  className="text-input"
                  type="text"
                  value={mealDraft.name}
                  onChange={(e) =>
                    setMealDraft((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  placeholder="e.g. Beef rice bowl"
                />
              </label>

              <label className="field-group">
                <span className="field-label">Calories</span>
                <input
                  className="text-input"
                  type="number"
                  value={mealDraft.calories}
                  onChange={(e) =>
                    setMealDraft((prev) => ({
                      ...prev,
                      calories: e.target.value,
                    }))
                  }
                  placeholder="0"
                />
              </label>

              <label className="field-group">
                <span className="field-label">Protein (g)</span>
                <input
                  className="text-input"
                  type="number"
                  value={mealDraft.protein}
                  onChange={(e) =>
                    setMealDraft((prev) => ({
                      ...prev,
                      protein: e.target.value,
                    }))
                  }
                  placeholder="0"
                />
              </label>
            </div>

            <div className="modal-actions">
              <button className="secondary-btn" onClick={closeMealModal}>
                Cancel
              </button>
              <button className="primary-btn" onClick={saveMealFromModal}>
                Save meal
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
}: {
  title: string;
  value: string;
  subtitle: string;
}) {
  return (
    <div className="summary-card">
      <div className="summary-card-title">{title}</div>
      <div className="summary-card-value">{value}</div>
      <div className="summary-card-subtitle">{subtitle}</div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  tone,
}: {
  title: string;
  value: string;
  subtitle: string;
  tone: string;
}) {
  return (
    <div className={`metric-card ${toneClass(tone)}`}>
      <div className="metric-card-title">{title}</div>
      <div className="metric-card-value">{value}</div>
      <div className="metric-card-subtitle">{subtitle}</div>
    </div>
  );
}

function LegendItem({
  label,
  tone,
}: {
  label: string;
  tone: string;
}) {
  return (
    <div className="legend-item">
      <span className={`legend-swatch ${toneClass(tone)}`} />
      <span>{label}</span>
    </div>
  );
}