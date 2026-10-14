import { demoLogins, fill } from "@/ui/copy";
import type { DemoLogin } from "./demo-logins";

/**
 * Filling the sign-in form from a demo card, kept out of the component so it can be tested
 * without a DOM (vitest runs in node). The types are structural on purpose — an
 * `HTMLInputElement` satisfies `TextField`, and so does a plain object in a test.
 */
export type TextField = { value: string };
export type Focusable = { focus: () => void };

export type LoginFormFields = {
  email: TextField | null;
  password: TextField | null;
  submit: Focusable | null;
};

/**
 * The three elements a fill touches, found through the form the card sits in rather than by
 * document id: the cards are inside the form, so there is nothing to keep in sync.
 */
export function loginFormFields(form: HTMLFormElement): LoginFormFields {
  return {
    email: form.elements.namedItem("email") as HTMLInputElement | null,
    password: form.elements.namedItem("password") as HTMLInputElement | null,
    submit: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
  };
}

/**
 * Puts the account in the two fields and moves focus to Sign in — it never submits, so the
 * person stays in control of signing in, and the next Enter or click is theirs. Returns the
 * line for the live region, so the announcement cannot drift from what was actually filled.
 */
export function fillLoginForm(fields: LoginFormFields, account: DemoLogin): string {
  if (fields.email) fields.email.value = account.email;
  if (fields.password) fields.password.value = account.password;
  fields.submit?.focus();
  return fill(demoLogins.filled, { role: demoLogins.roles[account.role].title });
}
