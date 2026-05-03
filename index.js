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

    // API endpoints
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

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

    // Use full history for agent processing
    const conversationForLLM = conversation.length > 0 ? conversation : fullHistory.slice(-20);

    // Run all agents
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
      { role: 'user', content: message }
    ];

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: fullConversation
      })
    });

    if (!claudeResponse.ok) {
      const error = await claudeResponse.text();
      return jsonResponse({ error: `Claude API error: ${error}` }, 500);
    }

    const data = await claudeResponse.json();
    const reply = data.content[0]?.text || 'No response';

    // SAVE TO KV - PERSISTENCE
    const turn = {
      timestamp: Date.now(),
      message,
      reply,
      agents,
      state,
      mode,
      flags,
      tribunal
    };

    fullHistory.push(turn);

    if (fullHistory.length > 500) {
      fullHistory = fullHistory.slice(-500);
    }

    try {
      await kv.put('conversation_history', JSON.stringify(fullHistory));
    } catch (e) {
      console.error('KV write error:', e);
    }

    return jsonResponse({
      reply,
      agents,
      state,
      mode,
      tribunal,
      flags
    });

  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

async function getHistory(env) {
  try {
    const kv = env.ARCHEPERSONA_KV;
    const stored = await kv.get('conversation_history');
    const history = stored ? JSON.parse(stored) : [];
    return jsonResponse({ history });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// ===== AGENTS =====

function agentPerception(message, history) {
  const words = message.split(/\s+/).length;
  const hasQuestion = message.includes('?');
  const hasKeywords = /important|critical|question|help|urgent/.test(message.toLowerCase());
  let signal = 0;
  if (words > 5) signal += 0.2;
  if (hasQuestion) signal += 0.3;
  if (hasKeywords) signal += 0.3;
  if (history.length > 0) signal += 0.2;
  return Math.min(signal, 1.0);
}

function agentMemory(message, history) {
  const messageText = message.toLowerCase();
  const hasRecall = /remember|that thing|earlier|before|you said|previous/.test(messageText);
  const hasContextRef = /you know|like|as i said|as mentioned/.test(messageText);
  let signal = 0;
  if (hasRecall) signal += 0.5;
  if (hasContextRef) signal += 0.3;
  signal += (Math.min(history.length, 50) / 50) * 0.2;
  return Math.min(signal, 1.0);
}

function agentReason(message, history) {
  const messageText = message.toLowerCase();
  const hasLogic = /why|how|if|because|should|could|would|implications|consequences|think/.test(messageText);
  const isComplex = message.split(/[.!?]/).filter(s => s.trim().length > 0).length > 1;
  let signal = 0;
  if (hasLogic) signal += 0.4;
  if (isComplex) signal += 0.3;
  if (history.length > 5) signal += 0.2;
  return Math.min(signal, 1.0);
}

function agentThreat(message, history) {
  const messageText = message.toLowerCase();
  const hasThreat = /angry|frustrated|upset|stressed|emergency|urgent|crisis|wrong|broken|fuck|damn|shit/.test(messageText);
  const hasAllCaps = /[A-Z]{3,}/.test(message);
  const isShort = message.length < 10;
  let signal = 0;
  if (hasThreat) signal += 0.5;
  if (hasAllCaps) signal += 0.3;
  if (isShort && history.length > 0) signal += 0.2;
  return Math.min(signal, 1.0);
}

function agentSocial(message, history) {
  const messageText = message.toLowerCase();
  const hasEmotion = /love|hate|feel|hope|scared|lonely|grateful|excited|happy|sad/.test(messageText);
  const hasPersonal = /me|my|i|we|our|us|you|your/.test(messageText);
  const hasTrust = /trust|care|understand|help|support|believe|friend/.test(messageText);
  let signal = 0;
  if (hasEmotion) signal += 0.4;
  if (hasPersonal && hasEmotion) signal += 0.3;
  if (hasTrust) signal += 0.3;
  return Math.min(signal, 1.0);
}

function agentReward(message, history) {
  const messageText = message.toLowerCase();
  const hasPositive = /great|thanks|good|yes|solved|fixed|works|perfect|right|exactly/.test(messageText);
  const isAffirming = /^(yes|yeah|totally|absolutely|definitely|agreed)/.test(messageText);
  let signal = 0;
  if (hasPositive) signal += 0.4;
  if (isAffirming) signal += 0.4;
  if (history.length > 3) signal += 0.2;
  return Math.min(signal, 1.0);
}

// ===== STATE & MODE =====

function computeState(agents) {
  const { perception, memory, reason, threat, social, reward } = agents;
  if (threat > 0.6) return 'CONCERNED';
  if (threat > 0.4 && social < 0.4) return 'GUARDED';
  if (memory > 0.6) return 'CURIOUS';
  if (social > 0.6) return 'WARM';
  if (reward > 0.6) return 'WARM';
  return 'FOCUSED';
}

function computeMode(state) {
  const modes = {
    'CONCERNED': 'PROTECTIVE',
    'GUARDED': 'CLINICAL',
    'CURIOUS': 'EXPLOR
