import { useState } from 'react';
import type { RoomView } from '@gambit3d/shared';
import { rpc } from '../../net/socket.js';
import { useStore } from '../../net/store.js';
import { Button, EmptyState, Panel, Toggle, useConfirm } from '../ui/index.js';
import { MemberRow } from './PlayerCard.js';

/**
 * Host and moderator tools.
 *
 * Rendered only when the server says the viewer holds the matching capability,
 * and every action is re-checked server-side before it takes effect.
 */
export function ModerationPanel({ room }: { room: RoomView }): JSX.Element | null {
  const toast = useStore((s) => s.toast);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  const can = room.you.can;
  const isStaff = can.kick || can.ban || can.approveJoins || can.lockRoom;
  if (!isStaff) return null;

  const call = async (key: string, event: string, payload: Record<string, unknown>): Promise<void> => {
    setBusy(key);
    const result = await rpc(event as never, { roomId: room.id, ...payload });
    setBusy(null);
    if (!result.ok) toast('error', result.message);
  };

  const others = room.members.filter((m) => m.id !== room.you.id);

  return (
    <div className="moderation">
      {can.approveJoins && (
        <Panel title={`Waiting to join (${room.pendingRequests.length})`}>
          {room.pendingRequests.length === 0 ? (
            <p className="muted">Nobody is waiting.</p>
          ) : (
            <ul className="moderation__requests">
              {room.pendingRequests.map((request) => (
                <li key={request.id} className="moderation__request">
                  <div>
                    <span className="moderation__requestName">{request.name}</span>
                    <span className="moderation__requestMeta">
                      rated {request.rating} · wants to {request.desiredRole === 'player' ? 'play' : 'watch'}
                    </span>
                  </div>
                  <div className="moderation__requestActions">
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === `ok-${request.id}`}
                      onClick={() =>
                        void call(`ok-${request.id}`, 'room:respondJoin', {
                          requestId: request.id,
                          accept: true,
                        })
                      }
                    >
                      Admit
                    </Button>
                    {request.desiredRole === 'player' && room.settings.allowSpectators && (
                      <Button
                        size="sm"
                        loading={busy === `watch-${request.id}`}
                        onClick={() =>
                          void call(`watch-${request.id}`, 'room:respondJoin', {
                            requestId: request.id,
                            accept: true,
                            asSpectator: true,
                          })
                        }
                      >
                        As spectator
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy === `no-${request.id}`}
                      onClick={() =>
                        void call(`no-${request.id}`, 'room:respondJoin', {
                          requestId: request.id,
                          accept: false,
                        })
                      }
                    >
                      Decline
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <Panel
        title={`People in the room (${room.members.length})`}
        actions={
          can.lockRoom && (
            <Toggle
              checked={room.locked}
              onChange={(locked) => void call('lock', 'room:lock', { locked })}
              label={room.locked ? 'Locked' : 'Open'}
            />
          )
        }
      >
        <div className="moderation__members">
          <MemberRow member={selfAsMember(room)} isSelf actions={undefined} />
          {others.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              isSelf={false}
              actions={
                <>
                  {can.mute && !member.isHost && (
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={busy === `mute-${member.id}`}
                      onClick={() =>
                        void call(`mute-${member.id}`, 'room:mute', { memberId: member.id, muted: !member.muted })
                      }
                    >
                      {member.muted ? 'Unmute' : 'Mute'}
                    </Button>
                  )}
                  {can.transferHost && !member.isHost && (
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={busy === `host-${member.id}`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Make ${member.name} the host?`,
                          message: 'You will keep your seat but lose host controls. This cannot be undone by you.',
                          confirmLabel: 'Transfer host',
                        });
                        if (ok) void call(`host-${member.id}`, 'room:transferHost', { memberId: member.id });
                      }}
                    >
                      Make host
                    </Button>
                  )}
                  {room.you.isHost && !member.isHost && (
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={busy === `mod-${member.id}`}
                      onClick={() =>
                        void call(`mod-${member.id}`, 'room:setModerator', {
                          memberId: member.id,
                          isModerator: !member.isModerator,
                        })
                      }
                    >
                      {member.isModerator ? 'Remove mod' : 'Make mod'}
                    </Button>
                  )}
                  {can.kick && !member.isHost && (
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy === `kick-${member.id}`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Remove ${member.name}?`,
                          message: member.seat
                            ? 'They are seated. Removing them during a live game forfeits it for them.'
                            : 'They can rejoin unless you also ban them.',
                          confirmLabel: 'Remove',
                          tone: 'danger',
                        });
                        if (ok) void call(`kick-${member.id}`, 'room:kick', { memberId: member.id });
                      }}
                    >
                      Kick
                    </Button>
                  )}
                  {can.ban && !member.isHost && (
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy === `ban-${member.id}`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Ban ${member.name} from this room?`,
                          message: 'They will be removed and cannot rejoin this room. The ban lasts as long as the room does.',
                          confirmLabel: 'Ban',
                          tone: 'danger',
                        });
                        if (ok) void call(`ban-${member.id}`, 'room:ban', { memberId: member.id });
                      }}
                    >
                      Ban
                    </Button>
                  )}
                </>
              }
            />
          ))}
        </div>
      </Panel>

      {can.ban && room.bans.length > 0 && (
        <Panel title={`Banned (${room.bans.length})`} collapsible defaultOpen={false}>
          <ul className="moderation__bans">
            {room.bans.map((ban) => (
              <li key={ban.id}>
                <span>{ban.name}</span>
                <Button
                  size="sm"
                  variant="subtle"
                  loading={busy === `unban-${ban.id}`}
                  onClick={() => void call(`unban-${ban.id}`, 'room:unban', { memberId: ban.id })}
                >
                  Unban
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {room.members.length === 1 && !can.approveJoins && (
        <EmptyState
          icon="👋"
          title="Nobody else is here yet"
          message="Share the room code or link and moderation tools will appear for each person who joins."
        />
      )}
    </div>
  );
}

/** Builds a MemberView for the viewer themselves, so the list is complete. */
function selfAsMember(room: RoomView) {
  const found = room.members.find((m) => m.id === room.you.id);
  if (found) return found;
  return {
    id: room.you.id,
    name: room.you.name,
    role: room.you.role,
    seat: room.you.seat,
    isHost: room.you.isHost,
    isModerator: room.you.isModerator,
    connected: true,
    muted: room.you.muted,
    rating: room.you.rating,
    provisional: false,
    joinedAt: Date.now(),
    disconnectedAt: null,
  };
}
