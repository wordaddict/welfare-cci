function startScheduledLoop({ label, startupDelayMs, intervalMs, run }) {
  let stopped = false;

  const schedule = (delay, reason) => {
    setTimeout(async () => {
      if (stopped) return;
      try {
        await run(reason);
      } catch (error) {
        console.error(`[${label}]`, error && error.message ? error.message : error);
      } finally {
        if (!stopped) schedule(intervalMs, 'scheduled');
      }
    }, delay);
  };

  schedule(startupDelayMs, 'startup');

  return () => {
    stopped = true;
  };
}

module.exports = { startScheduledLoop };
