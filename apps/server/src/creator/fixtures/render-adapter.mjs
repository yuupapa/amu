export function startRender(opts, loadStudioProducer, inFlightRenders, released) {
      const abortController = new AbortController();
      const state = { status: "rendering", cancel: () => abortController.abort() };
      const run = (async () => {
        let renderJob;
        try {
          const { createRenderJob, executeRenderJob } = await loadStudioProducer();
          const job = createRenderJob({
            fps: 30
          });
          renderJob = job;
          await executeRenderJob(job, abortController.signal);
          state.status = abortController.signal.aborted ? "cancelled" : "complete";
        } catch (err) {
          state.status = "failed";
          state.error = err.message;
        }
      })();
      inFlightRenders.set(abortController, run);
      return {state, run, abortController};
}
