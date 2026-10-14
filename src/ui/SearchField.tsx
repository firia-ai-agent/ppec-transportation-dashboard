import { Search } from "lucide-react";
import { search } from "./copy";
import { icon } from "./tokens";
import styles from "./SearchField.module.css";

/**
 * §2 global search (child first name/initial, route, vehicle) with the visible label §9
 * requires — the placeholder is a hint, never the label. The query is carried as `?q=` on
 * /today; the board reads it once the data layer lands in B-12.
 */
export function SearchField() {
  return (
    <form className={styles.form} role="search" action="/today">
      <label className={styles.label} htmlFor="shell-search">
        {search.label}
      </label>
      <div className={styles.row}>
        <Search size={icon.inline} aria-hidden="true" className={styles.icon} />
        <input
          id="shell-search"
          name="q"
          type="search"
          className={styles.input}
          placeholder={search.placeholder}
          autoComplete="off"
        />
        <button type="submit" className={styles.submit}>
          <span className="srOnly">{search.submit}</span>
          <Search size={icon.inline} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
