export type DayEntry = {
  calories?: number;
  protein?: number;
  weight?: number;
  notes?: string;
};

export type EntriesMap = Record<string, DayEntry>;

export type Goals = {
  calories: number;
  protein: number;
};

export type CoachProposal = {
  type: "meal" | "weight" | "goals";
  date: string | null;
  summary: string;
  calories: number | null;
  protein: number | null;
  weight: number | null;
  calorieTarget: number | null;
  proteinTarget: number | null;
  uncertainty: string;
};
