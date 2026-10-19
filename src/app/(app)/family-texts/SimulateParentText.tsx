"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus } from "lucide-react";
import { API } from "@/auth/access";
import { familyTexts } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import styles from "./texts.module.css";

/** One family the screen can open a thread for: the child's fixture key and their label. */
export type SimulateOption = { readonly key: string; readonly label: string };

const NEXT = "";

/**
 * "SIMULATE PARENT TEXT" (ledger #78) — a demo control on the tab strip. A parent texts that they
 * won't be home at their child's estimated drop-off; the server builds the words from the day and
 * sends them through the real inbound path (`/api/demo/parent-text`), then this opens that family's
 * thread, where the text lands and the agent's card follows.
 */
export function SimulateParentText({ options }: { readonly options: readonly SimulateOption[] }) {
  const router = useRouter();
  const [child, setChild] = useState(NEXT);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(API.demoParentText, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ child: child || null, among: options.map((o) => o.key) }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; child?: string; error?: string };
      if (body.ok && body.child) {
        startTransition(() => {
          router.push(`/family-texts?tab=all&thread=${encodeURIComponent(body.child!)}`);
          router.refresh();
        });
      } else {
        setMessage(
          body.error === "NO_PLAN" ? familyTexts.simulate.noPlan : body.error === "NO_RIDER" ? familyTexts.simulate.noRider : familyTexts.simulate.notSent,
        );
      }
    } catch {
      setMessage(familyTexts.simulate.notSent);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.simulate} data-simulate-parent-text="">
      <label className="srOnly" htmlFor="simulate-child">
        {familyTexts.simulate.pick}
      </label>
      <select id="simulate-child" className={styles.simulateSelect} value={child} onChange={(e) => setChild(e.target.value)} disabled={busy}>
        <option value={NEXT}>{familyTexts.simulate.nextDropoff}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <button type="button" className={styles.simulateButton} onClick={send} disabled={busy}>
        <MessageSquarePlus size={icon.chip} strokeWidth={icon.strokeWidth} aria-hidden="true" />
        <span>{busy ? familyTexts.simulate.sending : familyTexts.simulate.button}</span>
      </button>
      {message ? (
        <span role="status" className={styles.simulateMessage}>
          {message}
        </span>
      ) : null}
    </span>
  );
}
