-- ============================================================================
-- Hanabi — complete database setup (schema + game engine + RLS + Realtime)
-- Paste this entire file into the Supabase SQL editor and run it once.
--
-- Security model:
--   * The full game state (everyone's cards) lives in `games`, which has RLS
--     enabled and NO read policies — clients can NEVER select it directly.
--   * All reads and writes go through SECURITY DEFINER functions (RPCs) that
--     authenticate via a per-player secret token and return only the caller's
--     redacted view (own cards stripped to id + clue knowledge).
--   * `rooms` and `players` are publicly readable; they contain no hidden
--     info. Realtime is enabled on `rooms`: every mutation bumps its
--     `version`, which tells subscribed clients to refetch their view.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_player_id uuid,
  settings jsonb not null,
  phase text not null default 'lobby' check (phase in ('lobby', 'playing', 'ended')),
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  name text not null,
  seat int not null,
  created_at timestamptz not null default now(),
  unique (room_id, seat)
);

-- Per-player secret tokens. RLS with no policies: never readable via the API.
create table if not exists public.player_secrets (
  player_id uuid primary key references public.players (id) on delete cascade,
  token text not null
);

-- Authoritative game state. RLS with no policies: never readable via the API.
create table if not exists public.games (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- Finished-game history for shared head-to-head stats.
create table if not exists public.match_results (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  player_names text[] not null,
  settings jsonb not null,
  score int not null,
  max_score int not null,
  outcome text not null check (outcome in ('won', 'lost', 'finished')),
  finished_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.player_secrets enable row level security;
alter table public.games enable row level security;
alter table public.match_results enable row level security;

drop policy if exists rooms_public_read on public.rooms;
create policy rooms_public_read on public.rooms for select using (true);

drop policy if exists players_public_read on public.players;
create policy players_public_read on public.players for select using (true);

drop policy if exists match_results_public_read on public.match_results;
create policy match_results_public_read on public.match_results for select using (true);

-- Explicit grants for the readable tables (Supabase defaults already allow
-- this; stating it keeps the migration portable and self-documenting).
grant usage on schema public to anon, authenticated;
grant select on public.rooms, public.players, public.match_results to anon, authenticated;

-- games and player_secrets: RLS on, zero policies = nobody reads them via API.
-- Belt and suspenders: revoke direct table access too.
revoke all on public.games from anon, authenticated;
revoke all on public.player_secrets from anon, authenticated;
revoke insert, update, delete on public.rooms from anon, authenticated;
revoke insert, update, delete on public.players from anon, authenticated;
revoke insert, update, delete on public.match_results from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: broadcast room version bumps (no hidden info in this table)
-- ---------------------------------------------------------------------------

do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception
  when duplicate_object then null;   -- already added
  when undefined_object then null;   -- publication absent (local dev)
end $$;

-- ============================================================================
-- Pure game-engine functions (mirror src/engine/game.ts exactly)
-- ============================================================================

create or replace function public.hanabi_suits(p_suits int)
returns text[] language sql immutable as $$
  select (array['red','yellow','green','blue','white','rainbow'])[1:p_suits];
$$;

create or replace function public.hanabi_copies(p_number int)
returns int language sql immutable as $$
  select case p_number when 1 then 3 when 5 then 1 else 2 end;
$$;

create or replace function public.hanabi_validate_settings(p_settings jsonb)
returns void language plpgsql immutable as $$
begin
  if (p_settings->>'playerCount')::int not in (2, 3) then
    raise exception 'Players must be 2 or 3';
  end if;
  if (p_settings->>'maxClues')::int not between 2 and 10 then
    raise exception 'Clue tokens must be 2–10';
  end if;
  if (p_settings->>'errorsAllowed')::int not between 0 and 4 then
    raise exception 'Errors allowed must be 0–4';
  end if;
  if (p_settings->>'suits')::int not in (4, 5, 6) then
    raise exception 'Suits must be 4, 5, or 6';
  end if;
end;
$$;

-- Rainbow matches every COLOR clue; number clues match normally.
create or replace function public.hanabi_clue_matches(p_card jsonb, p_clue jsonb)
returns boolean language sql immutable as $$
  select case p_clue->>'kind'
    when 'number' then (p_card->>'number')::int = (p_clue->>'number')::int
    else p_card->>'color' = p_clue->>'color' or p_card->>'color' = 'rainbow'
  end;
$$;

create or replace function public.hanabi_score(p_state jsonb)
returns int language sql immutable as $$
  select coalesce(sum(value::int), 0)::int from jsonb_each_text(p_state->'stacks');
$$;

-- Colors whose next needed rank is fully discarded.
create or replace function public.hanabi_dead_stacks(p_state jsonb)
returns jsonb language plpgsql immutable as $$
declare
  v_dead jsonb := '[]';
  v_color text;
  v_height int;
  v_needed int;
  v_discarded int;
begin
  foreach v_color in array hanabi_suits((p_state->'settings'->>'suits')::int) loop
    v_height := coalesce((p_state->'stacks'->>v_color)::int, 0);
    continue when v_height >= 5;
    v_needed := v_height + 1;
    select count(*) into v_discarded
    from jsonb_array_elements(p_state->'discard') c
    where c.value->>'color' = v_color and (c.value->>'number')::int = v_needed;
    if v_discarded >= hanabi_copies(v_needed) then
      v_dead := v_dead || to_jsonb(v_color);
    end if;
  end loop;
  return v_dead;
end;
$$;

-- Fresh shuffled deal for the given settings.
create or replace function public.hanabi_new_game(p_settings jsonb)
returns jsonb language plpgsql volatile as $$
declare
  v_deck jsonb := '[]';
  v_shuffled jsonb;
  v_hands jsonb := '[]';
  v_hand jsonb;
  v_stacks jsonb := '{}';
  v_knowledge jsonb := '{}';
  v_id int := 0;
  v_len int;
  v_color text;
  v_number int;
  v_copy int;
  p int;
  i int;
begin
  perform hanabi_validate_settings(p_settings);

  foreach v_color in array hanabi_suits((p_settings->>'suits')::int) loop
    for v_number in 1..5 loop
      for v_copy in 1..hanabi_copies(v_number) loop
        v_deck := v_deck || jsonb_build_array(
          jsonb_build_object('id', v_id, 'color', v_color, 'number', v_number));
        v_id := v_id + 1;
      end loop;
    end loop;
    v_stacks := v_stacks || jsonb_build_object(v_color, 0);
  end loop;

  for i in 0..(v_id - 1) loop
    v_knowledge := v_knowledge || jsonb_build_object(i::text, jsonb_build_object(
      'cluedColors', '[]'::jsonb, 'cluedNumber', null,
      'notColors', '[]'::jsonb, 'notNumbers', '[]'::jsonb));
  end loop;

  select jsonb_agg(c.value order by random()) into v_shuffled
  from jsonb_array_elements(v_deck) c;

  for p in 1..(p_settings->>'playerCount')::int loop
    v_hand := '[]';
    for i in 1..5 loop
      v_len := jsonb_array_length(v_shuffled);
      v_hand := v_hand || jsonb_build_array(v_shuffled->(v_len - 1));
      v_shuffled := v_shuffled - (v_len - 1);
    end loop;
    v_hands := v_hands || jsonb_build_array(v_hand);
  end loop;

  return jsonb_build_object(
    'settings', p_settings,
    'deck', v_shuffled,
    'hands', v_hands,
    'stacks', v_stacks,
    'discard', '[]'::jsonb,
    'clues', (p_settings->>'maxClues')::int,
    'errors', 0,
    'currentPlayer', 0,
    'turn', 1,
    'finalTurnsRemaining', null,
    'status', 'playing',
    'knowledge', v_knowledge,
    'log', '[]'::jsonb,
    'lastClue', null);
end;
$$;

-- Draw a replacement card into the player's hand on their preferred side.
create or replace function public.hanabi_draw(p_state jsonb, p_player int, p_side text)
returns jsonb language plpgsql immutable as $$
declare
  s jsonb := p_state;
  v_deck jsonb := p_state->'deck';
  v_len int := jsonb_array_length(p_state->'deck');
  v_card jsonb;
  v_hand jsonb;
begin
  if v_len = 0 then
    return s;
  end if;
  v_card := v_deck->(v_len - 1);
  v_deck := v_deck - (v_len - 1);
  s := jsonb_set(s, '{deck}', v_deck);
  v_hand := s->'hands'->p_player;
  if p_side = 'left' then
    v_hand := jsonb_build_array(v_card) || v_hand;
  else
    v_hand := v_hand || jsonb_build_array(v_card);
  end if;
  s := jsonb_set(s, array['hands', p_player::text], v_hand);
  s := jsonb_set(s, '{log}', (s->'log') || jsonb_build_array(jsonb_build_object(
    'type', 'draw', 'turn', s->'turn', 'actor', p_player, 'cardId', v_card->'id')));
  if jsonb_array_length(v_deck) = 0 then
    -- Last card drawn: everyone, including this player, gets one final turn.
    -- +1 because the end-of-turn step decrements during the drawing turn too.
    s := jsonb_set(s, '{finalTurnsRemaining}',
      to_jsonb((s->'settings'->>'playerCount')::int + 1));
  end if;
  return s;
end;
$$;

-- Apply one turn action. Raises an exception (rolling back everything) for
-- any illegal move — including out-of-turn and duplicate submissions.
create or replace function public.hanabi_apply_action(p_state jsonb, p_player int, p_action jsonb)
returns jsonb language plpgsql volatile as $$
declare
  s jsonb := p_state;
  v_type text := p_action->>'type';
  v_turn int := (p_state->>'turn')::int;
  v_clues int := (p_state->>'clues')::int;
  v_max_clues int := (p_state->'settings'->>'maxClues')::int;
  v_player_count int := (p_state->'settings'->>'playerCount')::int;
  v_draw_side text := coalesce(p_action->>'drawSide', 'right');
  v_target int;
  v_clue jsonb;
  v_hand jsonb;
  v_card jsonb;
  v_card_id int;
  v_idx int;
  v_k jsonb;
  v_matched_ids jsonb := '[]';
  v_positions jsonb := '[]';
  v_entry jsonb;
  v_height int;
  v_success boolean;
  v_completed boolean := false;
  v_errors int;
  v_final int;
  v_status text;
  i int;
begin
  if s->>'status' <> 'playing' then
    raise exception 'The game is over';
  end if;
  if (s->>'currentPlayer')::int <> p_player then
    raise exception 'It is not your turn';
  end if;

  if v_type = 'clue' then
    v_target := (p_action->>'targetPlayer')::int;
    v_clue := p_action->'clue';
    if v_clues <= 0 then
      raise exception 'No clue tokens left';
    end if;
    if v_target = p_player then
      raise exception 'You cannot clue yourself';
    end if;
    v_hand := s->'hands'->v_target;
    if v_hand is null then
      raise exception 'No such player';
    end if;

    for i in 0..(jsonb_array_length(v_hand) - 1) loop
      v_card := v_hand->i;
      v_card_id := (v_card->>'id')::int;
      v_k := s->'knowledge'->(v_card_id::text);
      if hanabi_clue_matches(v_card, v_clue) then
        v_matched_ids := v_matched_ids || to_jsonb(v_card_id);
        v_positions := v_positions || to_jsonb(i);
        if v_clue->>'kind' = 'color' then
          if not (v_k->'cluedColors') ? (v_clue->>'color') then
            v_k := jsonb_set(v_k, '{cluedColors}', (v_k->'cluedColors') || to_jsonb(v_clue->>'color'));
          end if;
        else
          v_k := jsonb_set(v_k, '{cluedNumber}', v_clue->'number');
        end if;
      else
        if v_clue->>'kind' = 'color' then
          if not (v_k->'notColors') ? (v_clue->>'color') then
            v_k := jsonb_set(v_k, '{notColors}', (v_k->'notColors') || to_jsonb(v_clue->>'color'));
          end if;
        else
          if not exists (
            select 1 from jsonb_array_elements(v_k->'notNumbers') e
            where e.value = v_clue->'number'
          ) then
            v_k := jsonb_set(v_k, '{notNumbers}', (v_k->'notNumbers') || (v_clue->'number'));
          end if;
        end if;
      end if;
      s := jsonb_set(s, array['knowledge', v_card_id::text], v_k);
    end loop;

    if jsonb_array_length(v_matched_ids) = 0 then
      raise exception 'Clues must match at least one card';
    end if;

    s := jsonb_set(s, '{clues}', to_jsonb(v_clues - 1));
    v_entry := jsonb_build_object(
      'type', 'clue', 'turn', v_turn, 'actor', p_player, 'target', v_target,
      'clue', v_clue, 'positions', v_positions, 'cardIds', v_matched_ids);
    s := jsonb_set(s, '{log}', (s->'log') || jsonb_build_array(v_entry));
    s := jsonb_set(s, '{lastClue}', v_entry);

  elsif v_type = 'discard' then
    if not (s->'settings'->>'allowDiscardAtMaxClues')::boolean and v_clues >= v_max_clues then
      raise exception 'Cannot discard at maximum clue tokens';
    end if;
    v_hand := s->'hands'->p_player;
    v_idx := -1;
    for i in 0..(jsonb_array_length(v_hand) - 1) loop
      if (v_hand->i->>'id')::int = (p_action->>'cardId')::int then
        v_idx := i;
        exit;
      end if;
    end loop;
    if v_idx = -1 then
      raise exception 'That card is not in your hand';
    end if;
    v_card := v_hand->v_idx;
    s := jsonb_set(s, array['hands', p_player::text], v_hand - v_idx);
    s := jsonb_set(s, '{discard}', (s->'discard') || jsonb_build_array(v_card));
    s := jsonb_set(s, '{clues}', to_jsonb(least(v_max_clues, v_clues + 1)));
    s := jsonb_set(s, '{log}', (s->'log') || jsonb_build_array(jsonb_build_object(
      'type', 'discard', 'turn', v_turn, 'actor', p_player, 'card', v_card)));
    s := hanabi_draw(s, p_player, v_draw_side);

  elsif v_type = 'play' then
    v_hand := s->'hands'->p_player;
    v_idx := -1;
    for i in 0..(jsonb_array_length(v_hand) - 1) loop
      if (v_hand->i->>'id')::int = (p_action->>'cardId')::int then
        v_idx := i;
        exit;
      end if;
    end loop;
    if v_idx = -1 then
      raise exception 'That card is not in your hand';
    end if;
    v_card := v_hand->v_idx;
    s := jsonb_set(s, array['hands', p_player::text], v_hand - v_idx);
    v_height := coalesce((s->'stacks'->>(v_card->>'color'))::int, 0);
    v_success := (v_card->>'number')::int = v_height + 1;

    if v_success then
      s := jsonb_set(s, array['stacks', v_card->>'color'], v_card->'number');
      if (v_card->>'number')::int = 5 then
        v_completed := true;
        s := jsonb_set(s, '{clues}', to_jsonb(least(v_max_clues, (s->>'clues')::int + 1)));
      end if;
      if hanabi_score(s) = (s->'settings'->>'suits')::int * 5 then
        s := jsonb_set(s, '{status}', '"won"');
      end if;
    else
      s := jsonb_set(s, '{discard}', (s->'discard') || jsonb_build_array(v_card));
      v_errors := (s->>'errors')::int + 1;
      s := jsonb_set(s, '{errors}', to_jsonb(v_errors));
      if v_errors > (s->'settings'->>'errorsAllowed')::int then
        s := jsonb_set(s, '{status}', '"lost"');
      end if;
    end if;

    s := jsonb_set(s, '{log}', (s->'log') || jsonb_build_array(jsonb_build_object(
      'type', 'play', 'turn', v_turn, 'actor', p_player, 'card', v_card,
      'success', v_success, 'completedStack', v_completed)));
    if s->>'status' = 'playing' then
      s := hanabi_draw(s, p_player, v_draw_side);
    end if;

  else
    raise exception 'Unknown action';
  end if;

  -- End-of-turn bookkeeping (mirrors endTurn in src/engine/game.ts).
  v_status := s->>'status';
  if v_status <> 'playing' then
    s := jsonb_set(s, '{log}', (s->'log') || jsonb_build_array(jsonb_build_object(
      'type', 'gameEnd', 'turn', v_turn, 'outcome', v_status, 'score', hanabi_score(s))));
    return s;
  end if;
  if s->'finalTurnsRemaining' <> 'null'::jsonb then
    v_final := (s->>'finalTurnsRemaining')::int - 1;
    if v_final <= 0 then
      s := jsonb_set(s, '{status}', '"finished"');
      s := jsonb_set(s, '{log}', (s->'log') || jsonb_build_array(jsonb_build_object(
        'type', 'gameEnd', 'turn', v_turn, 'outcome', 'finished', 'score', hanabi_score(s))));
      return s;
    end if;
    s := jsonb_set(s, '{finalTurnsRemaining}', to_jsonb(v_final));
  end if;
  s := jsonb_set(s, '{turn}', to_jsonb(v_turn + 1));
  s := jsonb_set(s, '{currentPlayer}', to_jsonb(((s->>'currentPlayer')::int + 1) % v_player_count));
  return s;
end;
$$;

-- Free hand reorder (not a turn action). p_order must be a permutation of the
-- player's current card ids.
create or replace function public.hanabi_reorder(p_state jsonb, p_player int, p_order jsonb)
returns jsonb language plpgsql immutable as $$
declare
  v_hand jsonb := p_state->'hands'->p_player;
  v_new jsonb := '[]';
  v_found boolean;
  i int;
  j int;
begin
  if p_state->>'status' <> 'playing' then
    raise exception 'The game is over';
  end if;
  if v_hand is null then
    raise exception 'No such player';
  end if;
  if jsonb_array_length(p_order) <> jsonb_array_length(v_hand) then
    raise exception 'Order must be a permutation of your hand';
  end if;
  if (select count(distinct e.value::text) from jsonb_array_elements(p_order) e)
     <> jsonb_array_length(p_order) then
    raise exception 'Order must be a permutation of your hand';
  end if;
  for i in 0..(jsonb_array_length(p_order) - 1) loop
    v_found := false;
    for j in 0..(jsonb_array_length(v_hand) - 1) loop
      if (v_hand->j->>'id')::int = (p_order->>i)::int then
        v_new := v_new || jsonb_build_array(v_hand->j);
        v_found := true;
        exit;
      end if;
    end loop;
    if not v_found then
      raise exception 'Order must be a permutation of your hand';
    end if;
  end loop;
  return jsonb_set(p_state, array['hands', p_player::text], v_new);
end;
$$;

-- Redact the authoritative state down to what one seat may see.
-- This is the ONLY shape that ever leaves the server for a client.
create or replace function public.hanabi_view(p_state jsonb, p_seat int)
returns jsonb language plpgsql immutable as $$
declare
  v_own jsonb;
  v_partner_hands jsonb := '{}';
  v_partner_knowledge jsonb := '{}';
  v_player_count int := (p_state->'settings'->>'playerCount')::int;
  p int;
  i int;
  v_hand jsonb;
  v_card_id text;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.value->'id',
      'knowledge', p_state->'knowledge'->(c.value->>'id')) order by c.ordinality), '[]')
  into v_own
  from jsonb_array_elements(p_state->'hands'->p_seat) with ordinality c;

  for p in 0..(v_player_count - 1) loop
    continue when p = p_seat;
    v_hand := p_state->'hands'->p;
    v_partner_hands := v_partner_hands || jsonb_build_object(p::text, v_hand);
    for i in 0..(jsonb_array_length(v_hand) - 1) loop
      v_card_id := v_hand->i->>'id';
      v_partner_knowledge := v_partner_knowledge
        || jsonb_build_object(v_card_id, p_state->'knowledge'->v_card_id);
    end loop;
  end loop;

  return jsonb_build_object(
    'playerIndex', p_seat,
    'settings', p_state->'settings',
    'deckCount', jsonb_array_length(p_state->'deck'),
    'ownHand', v_own,
    'partnerHands', v_partner_hands,
    'partnerKnowledge', v_partner_knowledge,
    'stacks', p_state->'stacks',
    'deadStacks', hanabi_dead_stacks(p_state),
    'discard', p_state->'discard',
    'clues', p_state->'clues',
    'errors', p_state->'errors',
    'currentPlayer', p_state->'currentPlayer',
    'turn', p_state->'turn',
    'finalTurnsRemaining', p_state->'finalTurnsRemaining',
    'status', p_state->'status',
    'score', hanabi_score(p_state),
    'log', p_state->'log',
    'lastClue', p_state->'lastClue');
end;
$$;

-- ============================================================================
-- RPC layer (SECURITY DEFINER): the only door clients have
-- ============================================================================

-- Authenticate a (room code, player id, secret token) triple.
create or replace function public.hanabi_auth(p_room_code text, p_player_id uuid, p_token text)
returns table (room_id uuid, seat int)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    select r.id, p.seat
    from rooms r
    join players p on p.room_id = r.id
    join player_secrets ps on ps.player_id = p.id
    where upper(r.code) = upper(p_room_code)
      and p.id = p_player_id
      and ps.token = p_token;
  if not found then
    raise exception 'Not authorized for this room';
  end if;
end;
$$;

create or replace function public.hanabi_bump(p_room_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update rooms set version = version + 1, updated_at = now() where id = p_room_id;
$$;

-- Public room metadata + member list (no hidden info).
create or replace function public.hanabi_room_info(p_room_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'roomCode', r.code,
    'hostPlayerId', r.host_player_id,
    'settings', r.settings,
    'phase', r.phase,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'seat', p.seat, 'connected', true) order by p.seat)
      from players p where p.room_id = r.id), '[]'::jsonb))
  from rooms r where r.id = p_room_id;
$$;

create or replace function public.create_room(p_host_name text, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
  v_room_id uuid;
  v_player_id uuid;
  v_token text := gen_random_uuid()::text;
begin
  perform hanabi_validate_settings(p_settings);

  -- Rooms persist ~48h; expired ones are swept opportunistically here.
  delete from rooms where created_at < now() - interval '48 hours';

  loop
    v_code := (array['FOX','OWL','KOI','CAT','BEE','ELK','JAY','YAK','ANT','BAT'])
                [1 + floor(random() * 10)::int]
              || '-' || (100 + floor(random() * 900)::int)::text;
    exit when not exists (select 1 from rooms where code = v_code);
  end loop;

  insert into rooms (code, settings) values (v_code, p_settings) returning id into v_room_id;
  insert into players (room_id, name, seat) values (v_room_id, p_host_name, 0)
    returning id into v_player_id;
  insert into player_secrets (player_id, token) values (v_player_id, v_token);
  update rooms set host_player_id = v_player_id where id = v_room_id;

  return jsonb_build_object('roomCode', v_code, 'playerId', v_player_id, 'token', v_token);
end;
$$;

create or replace function public.join_room(
  p_room_code text, p_name text,
  p_rejoin_player_id uuid default null, p_rejoin_token text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room rooms%rowtype;
  v_count int;
  v_player_id uuid;
  v_token text := gen_random_uuid()::text;
begin
  select * into v_room from rooms where upper(code) = upper(p_room_code) for update;
  if not found then
    raise exception 'Room % not found', upper(p_room_code);
  end if;

  -- Rejoin with a previously issued identity restores the same seat.
  if p_rejoin_player_id is not null and p_rejoin_token is not null then
    if exists (
      select 1 from players p
      join player_secrets ps on ps.player_id = p.id
      where p.id = p_rejoin_player_id and p.room_id = v_room.id and ps.token = p_rejoin_token
    ) then
      perform hanabi_bump(v_room.id);
      return jsonb_build_object(
        'roomCode', v_room.code, 'playerId', p_rejoin_player_id, 'token', p_rejoin_token);
    end if;
  end if;

  if v_room.phase <> 'lobby' then
    raise exception 'Game already started';
  end if;
  select count(*) into v_count from players where room_id = v_room.id;
  if v_count >= 3 then
    raise exception 'Room is full';
  end if;

  insert into players (room_id, name, seat) values (v_room.id, p_name, v_count)
    returning id into v_player_id;
  insert into player_secrets (player_id, token) values (v_player_id, v_token);
  perform hanabi_bump(v_room.id);

  return jsonb_build_object('roomCode', v_room.code, 'playerId', v_player_id, 'token', v_token);
end;
$$;

create or replace function public.update_settings(
  p_room_code text, p_player_id uuid, p_token text, p_settings jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
begin
  select a.room_id into v_room_id from hanabi_auth(p_room_code, p_player_id, p_token) a;
  perform 1 from rooms where id = v_room_id for update;
  if not exists (select 1 from rooms where id = v_room_id and host_player_id = p_player_id) then
    raise exception 'Only the host can do that';
  end if;
  if not exists (select 1 from rooms where id = v_room_id and phase = 'lobby') then
    raise exception 'Settings are locked once the game starts';
  end if;
  perform hanabi_validate_settings(p_settings);
  update rooms set settings = p_settings where id = v_room_id;
  perform hanabi_bump(v_room_id);
end;
$$;

create or replace function public.start_game(p_room_code text, p_player_id uuid, p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  v_settings jsonb;
  v_count int;
begin
  select a.room_id into v_room_id from hanabi_auth(p_room_code, p_player_id, p_token) a;
  perform 1 from rooms where id = v_room_id for update;
  if not exists (select 1 from rooms where id = v_room_id and host_player_id = p_player_id) then
    raise exception 'Only the host can do that';
  end if;
  select count(*) into v_count from players where room_id = v_room_id;
  if v_count < 2 then
    raise exception 'Need at least 2 players';
  end if;
  select settings || jsonb_build_object('playerCount', v_count) into v_settings
  from rooms where id = v_room_id;
  update rooms set settings = v_settings, phase = 'playing' where id = v_room_id;
  insert into games (room_id, state) values (v_room_id, hanabi_new_game(v_settings))
    on conflict (room_id) do update set state = excluded.state, updated_at = now();
  perform hanabi_bump(v_room_id);
end;
$$;

create or replace function public.submit_action(
  p_room_code text, p_player_id uuid, p_token text, p_action jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  v_seat int;
  v_state jsonb;
  v_new jsonb;
begin
  select a.room_id, a.seat into v_room_id, v_seat
  from hanabi_auth(p_room_code, p_player_id, p_token) a;
  -- Row lock serializes concurrent submissions; the second of a double-tap
  -- then fails validation against the updated state.
  select state into v_state from games where room_id = v_room_id for update;
  if not found then
    raise exception 'Not in a running game';
  end if;

  v_new := hanabi_apply_action(v_state, v_seat, p_action);
  update games set state = v_new, updated_at = now() where room_id = v_room_id;

  if v_new->>'status' <> 'playing' then
    update rooms set phase = 'ended' where id = v_room_id;
    insert into match_results (room_code, player_names, settings, score, max_score, outcome)
    select r.code,
           (select array_agg(p.name order by p.seat) from players p where p.room_id = r.id),
           v_new->'settings',
           hanabi_score(v_new),
           (v_new->'settings'->>'suits')::int * 5,
           v_new->>'status'
    from rooms r where r.id = v_room_id;
  end if;
  perform hanabi_bump(v_room_id);
end;
$$;

create or replace function public.reorder_hand(
  p_room_code text, p_player_id uuid, p_token text, p_order jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  v_seat int;
  v_state jsonb;
begin
  select a.room_id, a.seat into v_room_id, v_seat
  from hanabi_auth(p_room_code, p_player_id, p_token) a;
  select state into v_state from games where room_id = v_room_id for update;
  if not found then
    raise exception 'Not in a running game';
  end if;
  update games set state = hanabi_reorder(v_state, v_seat, p_order), updated_at = now()
  where room_id = v_room_id;
  perform hanabi_bump(v_room_id);
end;
$$;

create or replace function public.rematch(p_room_code text, p_player_id uuid, p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  v_settings jsonb;
begin
  select a.room_id into v_room_id from hanabi_auth(p_room_code, p_player_id, p_token) a;
  perform 1 from rooms where id = v_room_id for update;
  if not exists (select 1 from rooms where id = v_room_id and host_player_id = p_player_id) then
    raise exception 'Only the host can do that';
  end if;
  select settings into v_settings from rooms where id = v_room_id;
  insert into games (room_id, state) values (v_room_id, hanabi_new_game(v_settings))
    on conflict (room_id) do update set state = excluded.state, updated_at = now();
  update rooms set phase = 'playing' where id = v_room_id;
  perform hanabi_bump(v_room_id);
end;
$$;

create or replace function public.back_to_lobby(p_room_code text, p_player_id uuid, p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
begin
  select a.room_id into v_room_id from hanabi_auth(p_room_code, p_player_id, p_token) a;
  perform 1 from rooms where id = v_room_id for update;
  if not exists (select 1 from rooms where id = v_room_id and host_player_id = p_player_id) then
    raise exception 'Only the host can do that';
  end if;
  delete from games where room_id = v_room_id;
  update rooms set phase = 'lobby' where id = v_room_id;
  perform hanabi_bump(v_room_id);
end;
$$;

-- The caller's complete snapshot: room metadata + their redacted game view.
create or replace function public.get_snapshot(p_room_code text, p_player_id uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  v_seat int;
  v_state jsonb;
begin
  select a.room_id, a.seat into v_room_id, v_seat
  from hanabi_auth(p_room_code, p_player_id, p_token) a;
  select state into v_state from games where room_id = v_room_id;
  return jsonb_build_object(
    'room', hanabi_room_info(v_room_id),
    'view', case when v_state is null then null else hanabi_view(v_state, v_seat) end,
    'version', (select version from rooms where id = v_room_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: clients may only call the RPCs (plus read the public tables)
-- ---------------------------------------------------------------------------

grant execute on function
  public.create_room(text, jsonb),
  public.join_room(text, text, uuid, text),
  public.update_settings(text, uuid, text, jsonb),
  public.start_game(text, uuid, text),
  public.submit_action(text, uuid, text, jsonb),
  public.reorder_hand(text, uuid, text, jsonb),
  public.rematch(text, uuid, text),
  public.back_to_lobby(text, uuid, text),
  public.get_snapshot(text, uuid, text)
to anon, authenticated;

-- Internal helpers are not callable by clients.
revoke execute on function
  public.hanabi_auth(text, uuid, text),
  public.hanabi_bump(uuid),
  public.hanabi_room_info(uuid),
  public.hanabi_new_game(jsonb),
  public.hanabi_apply_action(jsonb, int, jsonb),
  public.hanabi_reorder(jsonb, int, jsonb),
  public.hanabi_view(jsonb, int),
  public.hanabi_draw(jsonb, int, text)
from anon, authenticated, public;
