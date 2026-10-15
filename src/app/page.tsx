import { redirect } from "next/navigation";
import { homePathFor } from "@/auth/access";
import { getCaller } from "@/auth/caller";

/** The entry route reads a session, so it is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * The entry route sends each person to their own first page (§2 nav order, PRD §14): the board
 * for a coordinator or a director, the ramp check for the front desk — whose surface is the iPad,
 * not the console (ARCHITECTURE §1) — and sign-in for a visitor with no session. `homePathFor`
 * reads the one access table, so this redirect cannot send anyone to a page they would then be
 * refused.
 */
export default async function Home() {
  redirect(homePathFor(await getCaller()));
}
