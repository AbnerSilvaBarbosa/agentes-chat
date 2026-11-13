import type { ReactNode } from "react";
import { cx } from "../cx";

export interface BreadcrumbItem {
  label: string;
  /** Where the item leads. An item with neither this nor `onSelect` is plain text, as the last one always is. */
  href?: string;
  /** For an in-page change that has no address of its own; `href` wins when both are given. */
  onSelect?: () => void;
  /** Before the label: a company's image or color. */
  mark?: ReactNode;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  /** Names the landmark ("Caminho"). */
  label: string;
  className?: string;
}

/**
 * The way back up from where a page is: every item but the last leads to its level, the last is where the person
 * stands and is words only. Long names wrap inside their item instead of being cut.
 */
export function Breadcrumb({ items, label, className }: BreadcrumbProps) {
  return (
    <nav className={cx("ac-breadcrumb", className)} aria-label={label}>
      <ol className="ac-breadcrumb__list">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          const body = (
            <>
              {item.mark}
              <span className="ac-breadcrumb__label">{item.label}</span>
            </>
          );
          return (
            // Items repeat no label in one path, so the label keys them.
            <li key={item.label} className="ac-breadcrumb__item">
              {last ? (
                <span className="ac-breadcrumb__here" aria-current="page">
                  {body}
                </span>
              ) : item.href ? (
                <a
                  className="ac-link ac-link--muted ac-breadcrumb__link"
                  href={item.href}
                  onClick={
                    item.onSelect &&
                    ((e) => {
                      // A plain click is handled in the page; a modified one keeps the browser's own behaviour.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                      e.preventDefault();
                      item.onSelect?.();
                    })
                  }
                >
                  {body}
                </a>
              ) : item.onSelect ? (
                <button type="button" className="ac-link ac-link--muted ac-breadcrumb__link" onClick={item.onSelect}>
                  {body}
                </button>
              ) : (
                <span className="ac-breadcrumb__text">{body}</span>
              )}
              {!last && (
                <span className="ac-breadcrumb__sep" aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
