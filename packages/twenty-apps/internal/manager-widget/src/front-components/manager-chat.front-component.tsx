import { useState } from 'react';
import { defineFrontComponent } from 'twenty-sdk/define';

import { MANAGER_CHAT_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from '../constants/universal-identifiers';
import { type ManagerChatMessage } from '../types/ManagerChatMessage';
import { requestManagerAccessToken } from './utils/request-manager-access-token.util';
import { sendManagerMessage } from './utils/send-manager-message.util';

const MESSAGE_STYLE_BY_ROLE: Record<
  ManagerChatMessage['role'],
  { alignSelf: 'flex-end' | 'flex-start'; background: string; color: string }
> = {
  user: { alignSelf: 'flex-end', background: '#e8f0fe', color: 'inherit' },
  assistant: { alignSelf: 'flex-start', background: '#f1f1f1', color: 'inherit' },
  error: { alignSelf: 'flex-start', background: '#fdecea', color: '#611a15' },
};

const ManagerChat = () => {
  const [messages, setMessages] = useState<ManagerChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    const text = draft.trim();

    if (!text || sending) {
      return;
    }

    setDraft('');
    setSending(true);
    setMessages((previous) => [...previous, { role: 'user', text }]);

    try {
      const accessToken = await requestManagerAccessToken();
      const reply = await sendManagerMessage(accessToken, text);

      setMessages((previous) => [...previous, { role: 'assistant', text: reply }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.';

      setMessages((previous) => [...previous, { role: 'error', text: message }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <main
      style={{
        boxSizing: 'border-box',
        display: 'grid',
        gridTemplateRows: 'minmax(0, 1fr) auto',
        height: '100%',
        minHeight: '100%',
        padding: 16,
        width: '100%',
      }}
    >
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          minHeight: 0,
          overflow: 'auto',
        }}
      >
        {messages.length === 0 ? (
          <p style={{ opacity: 0.6 }}>
            Ask the Manager a CRM question, or ask it to create or update a record — writes
            always need your approval before anything happens.
          </p>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              style={{
                ...MESSAGE_STYLE_BY_ROLE[message.role],
                borderRadius: 8,
                maxWidth: '80%',
                padding: '8px 12px',
                whiteSpace: 'pre-wrap',
              }}
            >
              {message.text}
            </div>
          ))
        )}
        {sending ? <p style={{ opacity: 0.6 }}>Thinking…</p> : null}
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          handleSend();
        }}
        style={{ display: 'flex', gap: 8, paddingTop: 12 }}
      >
        <input
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask the Manager…"
          style={{ flex: 1, padding: 8 }}
          type="text"
          value={draft}
        />
        <button disabled={sending || !draft.trim()} type="submit">
          Send
        </button>
      </form>
    </main>
  );
};

export default defineFrontComponent({
  universalIdentifier: MANAGER_CHAT_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'manager-chat',
  description: 'Chat with the JAI OS Manager agent',
  component: ManagerChat,
});
