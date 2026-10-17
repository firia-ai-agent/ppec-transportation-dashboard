import { toast } from "./copy";

/**
 * NOTICES — the one-line messages a redirect carries with it.
 *
 * A redirect is silent by itself: you asked for `/plan-routes` and you are looking at the live
 * map, with nothing saying why. So the guard that moves you adds `?notice=` to where it sends
 * you, and the shell reads it and says the one sentence (src/ui/NoticeToast.tsx).
 *
 * Pure module — no `next/*`, no React — so the server guard and the client toast share one
 * parameter name and one key, and neither writes the string down a second time.
 */
export const NOTICE_PARAM = "notice";

/**
 * The keys, and the words each one is. A key in a URL, never a sentence: a visitor can edit the
 * address bar, and the worst they can do with this is pick a different one of these.
 */
const messages = {
  /** §9.3: a typed URL for a page this role's menu does not carry. */
  "not-on-your-menu": toast.notOnMenu,
} as const;

export type NoticeKey = keyof typeof messages;

export const NOT_ON_YOUR_MENU: NoticeKey = "not-on-your-menu";

/** The sentence for a `?notice=` value, or `null` for one we do not recognise. */
export function noticeMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  return value in messages ? messages[value as NoticeKey] : null;
}

/** `/live-map` + the notice to say on arrival. Keeps any query the path already carries. */
export function withNotice(path: string, key: NoticeKey): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${NOTICE_PARAM}=${key}`;
}
