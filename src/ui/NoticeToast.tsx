"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "./copy";
import { NOTICE_PARAM, noticeMessage } from "./notice";
import { icon } from "./tokens";
import styles from "./NoticeToast.module.css";

/**
 * THE LINE A REDIRECT COULD NOT SAY.
 *
 * §9.3: the menu hides what a role cannot use, and a typed URL for one of those pages sends the
 * person to their own home rather than to a 403 card with no way back (src/auth/page-guard.ts).
 * Moved without a word, that would be its own small mystery — you asked for Plan routes and you
 * are looking at the live map — so the guard attaches `?notice=` and this says the sentence:
 * "Not on your menu".
 *
 * `role="status"` and `aria-live="polite"`: it is announced after the page it arrived on, never
 * over it, and it steals no focus. It is not an alert — nothing went wrong, and the person is
 * on a working screen.
 *
 * It is the URL, and only the URL. No state and no effect: the notice is on screen exactly
 * while `?notice=` is in the address, so walking to the next screen leaves it behind and
 * Dismiss is one `router.replace` that takes the parameter off (no scroll, no history entry) —
 * which is also what stops a reload repeating a sentence about something that happened once.
 */
export function NoticeToast() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const message = noticeMessage(params.get(NOTICE_PARAM));
  if (!message) return null;

  const dismiss = () => {
    const next = new URLSearchParams(params.toString());
    next.delete(NOTICE_PARAM);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className={styles.toast} role="status" aria-live="polite" data-notice>
      <p className={styles.message}>{message}</p>
      <button type="button" className={styles.dismiss} onClick={dismiss}>
        <X size={icon.inline} aria-hidden="true" />
        <span className="srOnly">{toast.dismiss}</span>
      </button>
    </div>
  );
}
