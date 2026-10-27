import { displayRating } from '../server/editorial.ts';
export function Rating({ value }: { value: number }) {
  const rating = displayRating(value);
  return (
    <span className="rating" role="img" aria-label={`${rating}分，满分5分`}>
      {Array.from({ length: 5 }, (_, i) => {
        const fill = Math.max(0, Math.min(1, rating - i));
        return (
          <svg key={i} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8l-6.2 3.3 1.2-6.9-5-4.9 6.9-1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8l-6.2 3.3 1.2-6.9-5-4.9 6.9-1Z"
              fill="currentColor"
              style={{ clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)` }}
            />
          </svg>
        );
      })}
    </span>
  );
}
