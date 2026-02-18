"use client";

export default function MeetingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-screen items-center justify-center" style={{ background: "#F8F8F9" }}>
      <div className="max-w-md rounded-lg bg-white p-8 shadow-sm" style={{ border: "1px solid #E5E5E8" }}>
        <h2 className="text-lg font-semibold" style={{ color: "#1D2024" }}>
          Something went wrong
        </h2>
        <p className="mt-2 text-sm" style={{ color: "#6B6F76" }}>
          {error.message || "An unexpected error occurred."}
        </p>
        <div className="mt-4 flex gap-3">
          <button
            onClick={reset}
            className="rounded-md px-4 py-2 text-sm font-medium text-white"
            style={{ background: "#5E6AD2" }}
          >
            Try Again
          </button>
          <a
            href="/meetings"
            className="rounded-md px-4 py-2 text-sm font-medium"
            style={{ color: "#6B6F76", border: "1px solid #E5E5E8" }}
          >
            Reload Page
          </a>
        </div>
      </div>
    </div>
  );
}
