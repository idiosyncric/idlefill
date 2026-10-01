/**
 * hello-tool fixture (issue #15) — a synthetic tool module proving the
 * discovery mechanism end-to-end over the real stdio process. The test points
 * IDLEFILL_MCP_TOOLS at this file; it is NOT reached by the adapters/<dir>
 * glob (the fixture lives below the bounded scan depth, on purpose).
 *
 * Module contract (see mcp-tools-registry.mjs): default-export
 * { api, tools, call }. ctx = { project, paths, config, arbiter, log }.
 */
export default {
  api: 1,
  tools: [
    {
      name: 'hello',
      description: 'Fixture tool (issue #15): echoes a greeting plus the call context it was handed.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'who to greet' },
        },
      },
    },
  ],
  async call(name, args, ctx) {
    // Prove the server supplied the full context — the module never resolves
    // config or paths itself.
    return {
      ok: true,
      hello: `hello ${args?.name || 'world'}`,
      tool: name,
      project: ctx.project,
      known_projects: [...(ctx.paths?.keys?.() || [])],
      arbiter_is_function: typeof ctx.arbiter === 'function',
      log_is_function: typeof ctx.log === 'function',
    };
  },
};
