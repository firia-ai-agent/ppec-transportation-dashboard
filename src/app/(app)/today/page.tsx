import { nav, unbuilt } from "@/ui/copy";
import { Placeholder } from "@/ui/Placeholder";

/**
 * SURF-01 board (§4.1). There is no data layer yet, so this says the board is not built
 * rather than render an empty board, which would read as "no child rides today".
 */
export default function TodayPage() {
  return <Placeholder page={nav.today} body={unbuilt.today} />;
}
