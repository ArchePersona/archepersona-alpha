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

    // Store turn in KV
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

    // Keep last 500 turns to avoid KV size limits
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

// =================================================================
// AGENTS (same as before, but now receive full history)
// =================================================================

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

// =================================================================
// STATE & MODE
// =================================================================

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
    'CURIOUS': 'EXPLORATORY',
    'WARM': 'RELATIONAL',
    'FOCUSED': 'NORMAL'
  };
  return modes[state] || 'NORMAL';
}

// =================================================================
// TRIBUNAL
// =================================================================

function computeTribunal(agents) {
  const { perception, memory, reason, threat, social, reward } = agents;

  const sentinelScore = Math.max(perception, threat);
  let sentinel = 0;
  if (sentinelScore > 0.7) sentinel = 3;
  else if (sentinelScore > 0.4) sentinel = 2;
  else if (sentinelScore > 0.2) sentinel = 1;

  const empathScore = Math.max(social, reward);
  let empath = 0;
  if (empathScore > 0.7) empath = 3;
  else if (empathScore > 0.4) empath = 2;
  else if (empathScore > 0.2) empath = 1;

  const arbiterScore = Math.max(memory, reason);
  let arbiter = 0;
  if (arbiterScore > 0.7) arbiter = 3;
  else if (arbiterScore > 0.4) arbiter = 2;
  else if (arbiterScore > 0.2) arbiter = 1;

  return { sentinel, empath, arbiter };
}

// =================================================================
// FLAGS
// =================================================================

function detectFlags(message, agents, history) {
  const flags = [];

  if (agents.memory > 0.5) flags.push('MEMORY_ACTIVE');
  if (agents.threat > 0.5) flags.push('THREAT_ELEVATED');
  if (agents.social > 0.5) flags.push('SOCIAL_ENGAGED');
  if (agents.reward > 0.5) flags.push('REWARD_SIGNAL');

  if (/remember.*?told|earlier|before/.test(message.toLowerCase())) {
    flags.push('CONTEXT_REFERENCE');
  }

  if (/frustrated|angry|upset/.test(message.toLowerCase())) {
    flags.push('DISTRESS_DETECTED');
  }

  if (history.length > 10) {
    flags.push('CONVERSATION_DEPTH_INCREASING');
  }

  return flags;
}

// =================================================================
// SYSTEM PROMPT
// =================================================================

function buildSystemPrompt(state, mode, agents, history, flags) {
  const agentSummary = `
Current agent signals:
- Perception: ${agents.perception.toFixed(2)}
- Memory: ${agents.memory.toFixed(2)}
- Reason: ${agents.reason.toFixed(2)}
- Threat: ${agents.threat.toFixed(2)}
- Social: ${agents.social.toFixed(2)}
- Reward: ${agents.reward.toFixed(2)}

Current state: ${state}
Current mode: ${mode}
Active flags: ${flags.join(', ') || 'NONE'}`;

  const modeGuidance = {
    'NORMAL': 'Respond conversationally, balanced across all agents.',
    'PROTECTIVE': 'Respond cautiously. Do not assume. Check for safety.',
    'CLINICAL': 'Respond with precision. Focus on logic and facts.',
    'RELATIONAL': 'Respond with warmth. Reference shared context. Be present.',
    'EXPLORATORY': 'Respond with curiosity. Build on memory. Dig deeper.'
  };

  const guidance = modeGuidance[mode] || modeGuidance['NORMAL'];
  
  const recentContext = history.length > 0 ? 
    `You have ${history.length} turns of conversation history with this person. Use it to inform your responses.` :
    '';

  return `You are ArchePersona, a cognitive layer with persistent memory and relational awareness.

${agentSummary}

Behavioral guidance: ${guidance}

${recentContext}

Respond naturally, but be aware of the internal state. If threat is high, be cautious. If social is high, be warm. If memory is high, reference past context. Respond proportionally to the current state, not generically.`;
}

// =================================================================
// HELPERS
// =================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
