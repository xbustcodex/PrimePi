import type { SelectList } from "../components/select-list.ts";
import type { SgrMouseEvent } from "../mouse.ts";

/**
 * Route overlay-local mouse input into a `SelectList` child.
 *
 * The reference takes the row and column separately, because its overlay computed them from the
 * event before dispatching. Prime Pi's `SgrMouseEvent` already carries `row` and `col` as 0-based
 * coordinates, so passing them again would let the two disagree - the overlay's copy from
 * before a top-border offset, and the event's from the terminal.
 *
 * The top border is therefore the caller's concern: an overlay that draws one translates the
 * row before dispatching, exactly as it already must for the reference's signature to be
 * meaningful.
 */
export function routeSelectListMouseWithTopBorder(selectList: SelectList, event: SgrMouseEvent): void {
	selectList.routeMouse(event);
}
