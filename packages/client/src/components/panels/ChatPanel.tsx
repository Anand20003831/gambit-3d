import { useEffect, useRef, useState } from 'react';
import { LIMITS, type ChatMessage, type RoomView } from '@gambit3d/shared';
import { rpc } from '../../net/socket.js';
import { useStore } from '../../net/store.js';
import { Button, TextInput } from '../ui/index.js';

/**
 * Room chat.
 *
 * Player and spectator messages are separate channels; the server decides which
 * a viewer may write to and which they may read, and this component only mirrors
 * the capability flags it was given.
 */
export function ChatPanel({ room }: { room: RoomView }): JSX.Element {
  const chat = useStore((s) => s.chat);
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const canChat = room.you.can.chatAsPlayer || room.you.can.chatAsSpectator;
  const channel = room.you.seat ? 'player' : 'spectator';

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat.length]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const result = await rpc<'chat:send', { message: ChatMessage }>('chat:send', {
      roomId: room.id,
      text,
      channel,
    });
    setSending(false);
    if (!result.ok) {
      toast('error', result.message);
      return;
    }
    setDraft('');
  };

  const reason = room.you.muted
    ? 'You have been muted in this room.'
    : channel === 'player'
      ? 'The host has turned off player chat.'
      : 'The host has turned off spectator chat.';

  return (
    <div className="chat">
      <div className="chat__log" ref={scroller} role="log" aria-label="Room chat" aria-live="polite">
        {chat.length === 0 && <p className="chat__empty">No messages yet.</p>}
        {chat.map((message) => (
          <ChatLine key={message.id} message={message} isSelf={message.authorId === room.you.id} />
        ))}
      </div>

      <form
        className="chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <TextInput
          id="chat-input"
          value={draft}
          disabled={!canChat}
          maxLength={LIMITS.chatMaxLength}
          placeholder={canChat ? `Message as ${channel}…` : reason}
          onChange={(event) => setDraft(event.target.value)}
          autoComplete="off"
        />
        <Button type="submit" variant="primary" size="sm" disabled={!canChat || draft.trim().length === 0} loading={sending}>
          Send
        </Button>
      </form>
      {!canChat && <p className="chat__blocked">{reason}</p>}
    </div>
  );
}

function ChatLine({ message, isSelf }: { message: ChatMessage; isSelf: boolean }): JSX.Element {
  if (message.channel === 'system') {
    return (
      <p className="chat__system">
        <span className="chat__time">{time(message.at)}</span> {message.text}
      </p>
    );
  }
  return (
    <p className={`chat__line chat__line--${message.channel} ${isSelf ? 'is-self' : ''}`}>
      <span className="chat__time">{time(message.at)}</span>
      <span className="chat__author">{message.authorName}</span>
      {/* React escapes this; chat is additionally sanitised on the server. */}
      <span className="chat__text">{message.text}</span>
    </p>
  );
}

function time(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
