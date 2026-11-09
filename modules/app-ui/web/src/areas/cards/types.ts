// Shapes the cards area reads. Our own file (MIT).
export interface CoreCard {
  id: string;
  task: string;
  bot: string;
  tool: string;
  summary: string;
  expiresAt: string;
  state: string;
  decision: { answer?: string } | null;
}
export interface QuestionSpec {
  prompt: string;
  options: { label: string; description?: string }[];
  multi?: boolean;
  allowText: boolean;
}
export interface Question {
  id: string;
  state: "pending" | "answered" | "expired";
  bot: string;
  task: string;
  title: string;
  questions: QuestionSpec[];
  createdAt: number;
  expiresAt: number;
  answers?: { selected: number[]; text?: string }[];
}
export interface NotifEvent {
  type: string;
  id: string;
  bot: string;
  title: string;
  body: string;
  at: number;
}
