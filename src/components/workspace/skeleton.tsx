/** List-row placeholders while a screen has nothing cached yet; also the route loading state. */
export function Loading() {
  return (
    <div className="skeleton-list" role="status">
      <span className="sr-only">Loading your workspace…</span>
      {[0, 1, 2, 3, 4].map((row) => (
        <span className="skeleton-row" key={row} aria-hidden="true">
          <span className="skeleton-block skeleton-avatar" />
          <span className="skeleton-block skeleton-line" />
          <span className="skeleton-block skeleton-line short" />
        </span>
      ))}
    </div>
  );
}
