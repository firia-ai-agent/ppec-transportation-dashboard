"use client";

import { useId, useState, type MouseEvent } from "react";
import { ClipboardList, ConciergeBell, ShieldCheck, type LucideIcon } from "lucide-react";
import type { DemoAccountIcon } from "@/auth/demo-accounts";
import { demoLogins as copy, fill } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { DemoLogin } from "./demo-logins";
import { fillLoginForm, loginFormFields } from "./fill-form";
import styles from "./login.module.css";

/** §2: one icon set, 1.75 stroke. Names come from the shared demo-accounts config. */
const ICONS: Record<DemoAccountIcon, LucideIcon> = {
  "shield-check": ShieldCheck,
  "clipboard-list": ClipboardList,
  "concierge-bell": ConciergeBell,
};

/**
 * Demo accounts under the sign-in form (founder decision, DECISION-LEDGER row 57).
 *
 * A card fills the two fields and moves focus to Sign in; it does not submit, so nobody is
 * signed in by a click they meant as "show me this one", and the blue Sign in button stays the
 * only primary action on the page (these are outlined secondaries). The three identical-looking
 * buttons get their role in their accessible name, so a screen reader hears which is which, and
 * the fill is announced in a live region — sr-only, so it is reliably read without the layout
 * shifting under the fields that just changed.
 *
 * It renders inside the <form>, which is how a card reaches the fields: `button.form` is the
 * form it sits in, so there are no element ids to keep in step with the page.
 */
export function DemoLogins({ accounts }: { accounts: DemoLogin[] }) {
  const [announcement, setAnnouncement] = useState("");
  const headingId = useId();

  if (accounts.length === 0) return null;

  function onUse(event: MouseEvent<HTMLButtonElement>, account: DemoLogin) {
    const form = event.currentTarget.form;
    if (!form) return;
    setAnnouncement(fillLoginForm(loginFormFields(form), account));
  }

  return (
    <section className={styles.demo} aria-labelledby={headingId}>
      <p className="srOnly" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2 id={headingId} className={styles.divider}>
        <span className={styles.dividerText}>{copy.divider}</span>
      </h2>
      <ul className={styles.cards}>
        {accounts.map((account) => {
          const role = copy.roles[account.role];
          const RoleIcon = ICONS[account.icon];
          return (
            <li key={account.role} className={styles.cardItem}>
              <p className={styles.cardHead}>
                <RoleIcon size={icon.inline} aria-hidden="true" />
                <span className={styles.cardTitle}>{role.title}</span>
              </p>
              <p className={styles.cardDescription}>{role.description}</p>
              <dl className={styles.creds}>
                <dt className={styles.credLabel}>{copy.emailLabel}</dt>
                <dd className={`${styles.credValue} mono`}>{account.email}</dd>
                <dt className={styles.credLabel}>{copy.passwordLabel}</dt>
                <dd className={`${styles.credValue} mono`}>{account.password}</dd>
              </dl>
              <button
                type="button"
                className={styles.use}
                aria-label={fill(copy.useRole, { role: role.title })}
                onClick={(event) => onUse(event, account)}
              >
                {copy.use}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
