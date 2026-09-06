import { routeAgentRequest } from "agents";
import { CelmuxCallAgent } from "./call-agent";
import { handleCallApi, handleVoiceTestApi } from "./sfu";

export { CelmuxCallAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const callMatch = url.pathname.match(/^\/call\/([0-9a-f-]+)(?:\/.*)?$/i);
    if (callMatch) {
      const agent = env.CelmuxCallAgent.get(env.CelmuxCallAgent.idFromName(callMatch[1]));
      return agent.fetch(request);
    }
    const voiceTest = await handleVoiceTestApi(request, env);
    if (voiceTest) return voiceTest;
    const call = await handleCallApi(request, env);
    if (call) return call;
    const agent = await routeAgentRequest(request, env);
    return agent ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
