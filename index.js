// ArchePersona on Cloudflare Workers
// With persistent KV storage for long-term rapport

export default {
  async fetch(request, env, ctx) {
    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    const url = new URL(request.url);

    // API endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    // Get history endpoint
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return getHistory(env);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleChat(request, env) {
  try {
    const { message, conversation = [] } = await request.json();
    const apiKey = env.ANTHROPIC_API_KEY;
    const kv = env.ARCHEPERSONA_KV;

    if (!apiKey) {
      return jsonResponse({ error: 'API key not configured' }, 500);
    }

    if (!message || !message.trim()) {
      return jsonResponse({ error: 'Empty message' }, 400);
    }

    // Load full history from KV
    let fullHistory = [];
    try {
      const stored = await kv.get('conversation_history');
      if (stored) {
        fullHistory = JSON.parse(stored);
      }
    } catch (e) {
      console.error('KV read error:', e);
    }

    // Use full history for agent processing (long-term context)
    // But use current conversation for LLM call (avoid token bloat)
    const conversationForLLM = conversation.length > 0 ? conversation : fullHistory.slice(-20);

    // Run all agents with full history context
    const agents = {
      perception: agentPerception(message, fullHistory),
      memory: agentMemory(message, fullHistory),
      reason: agentReason(message, fullHistory),
      threat: agentThreat(message, fullHistory),
      social: agentSocial(message, fullHistory),
      reward: agentReward(message, fullHistory)
    };

    // Compute state and mode
    const state = computeState(agents);
    const mode = computeMode(state);

    // Compute Tribunal
    const tribunal = computeTribunal(agents);

    // Detect flags
    const flags = detectFlags(message, agents, fullHistory);

    // Build system prompt
    const systemPrompt = buildSystemPrompt(state, mode, agents, fullHistory, flags);

    // Call Claude
    const fullConversation = [
      ...conversationForLLM,
      { role: 'user', content
