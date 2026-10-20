"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { API } from "@/auth/access";
import { FEEDBACK_MAX } from "@/modules/feedback/limits";
import { feedbackCopy } from "./copy";
import { icon } from "./tokens";
import bar from "./DemoRestart.module.css";
import dialog from "./ConfirmRestart.module.css";
import styles from "./Feedback.module.css";

type Step = "IDLE" | "WRITING" | "SENDING" | "SAVED";

/** Send one line; true when the server kept it. The words go in the body, never the URL. */
export async function sendFeedback(body: string, pagePath: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const response = await fetchImpl(API.feedback, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, pagePath }),
  });
  return response.ok;
}

/**
 * THE DEMO BAR'S FEEDBACK BUTTON (ledger #82): beside Restart demo day, for every role — anyone on
 * staff may say what should change. One field, Send or Cancel, and "Thanks — saved." Escape and
 * the scrim are Cancel, as they are Keep plan on the restart question it borrows its shell from.
 */
export function Feedback() {
  const pathname = usePathname() ?? "/";
  const [step, setStep] = useState<Step>("IDLE");
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);

  const close = () => {
    setStep("IDLE");
    setFailed(false);
  };

  useEffect(() => {
    if (step !== "WRITING") return;
    field.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  useEffect(() => {
    if (step !== "SAVED") return;
    const timer = setTimeout(() => setStep("IDLE"), 2500);
    return () => clearTimeout(timer);
  }, [step]);

  const send = async () => {
    const body = text.trim();
    if (body === "" || step === "SENDING") return;
    setStep("SENDING");
    setFailed(false);
    try {
      if (await sendFeedback(body, pathname)) {
        setText("");
        setStep("SAVED");
        return;
      }
    } catch {
      // The network refused: the same line as a refusal, and the words stay to send again.
    }
    setFailed(true);
    setStep("WRITING");
  };

  const open = step === "WRITING" || step === "SENDING";
  return (
    <span className={bar.wrap}>
      {step === "SAVED" ? (
        <span role="status" className={bar.failed}>
          {feedbackCopy.saved}
        </span>
      ) : null}
      <button
        type="button"
        className={bar.button}
        data-feedback-open=""
        onClick={() => setStep("WRITING")}
        aria-haspopup="dialog"
      >
        <MessageSquare size={icon.chip} aria-hidden="true" />
        <span className={bar.label}>{feedbackCopy.button}</span>
      </button>
      {open ? (
        <div className={dialog.dialog} data-feedback-dialog="">
          <div className={dialog.scrim} onClick={close} aria-hidden="true" />
          <form
            className={`${dialog.card} ${styles.wide}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <h2 className={dialog.title} id="feedback-title">
              {feedbackCopy.title}
            </h2>
            <div className={styles.form}>
              <label className={styles.label} htmlFor="feedback-body">
                {feedbackCopy.label}
              </label>
              <textarea
                id="feedback-body"
                ref={field}
                className={styles.field}
                value={text}
                maxLength={FEEDBACK_MAX}
                onChange={(event) => setText(event.target.value)}
              />
              {failed ? (
                <p role="status" className={styles.note}>
                  {feedbackCopy.failed}
                </p>
              ) : null}
            </div>
            <div className={dialog.actions}>
              <button type="button" className={dialog.button} onClick={close} disabled={step === "SENDING"}>
                {feedbackCopy.cancel}
              </button>
              <button
                type="submit"
                className={dialog.button}
                data-variant="primary"
                data-feedback-send=""
                disabled={step === "SENDING" || text.trim() === ""}
              >
                {step === "SENDING" ? feedbackCopy.sending : feedbackCopy.send}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </span>
  );
}
