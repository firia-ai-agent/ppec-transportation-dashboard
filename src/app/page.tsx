import { redirect } from "next/navigation";

/** The console opens on the board (§2 nav order, PRD §14). */
export default function Home() {
  redirect("/today");
}
