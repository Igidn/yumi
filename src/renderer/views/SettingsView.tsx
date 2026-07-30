export function SettingsView() {
  return (
    <div className="container-app">
      <div className="max-w-[480px]">
        <h2 className="mb-4 text-[15px] font-semibold text-ink">
          Text-to-Speech
        </h2>
        <div className="flex items-center justify-between rounded-lg bg-field px-4 py-3">
          <span className="text-[13px] text-ink">Backend</span>
          <span className="text-[13px] text-muted">Web Speech API</span>
        </div>
        <p className="mt-2 text-[12px] text-muted">
          Uses your system's built-in voice. Additional backends (Edge, Kokoro)
          will be available in a future update.
        </p>
      </div>
    </div>
  );
}
