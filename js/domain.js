/*
 * Domänenlogik der Platzreservierung (rein, ohne DOM/Speicher).
 * Läuft im Browser (window.Domain) und in Node (require) – dient später als
 * Referenz für die Datenbank-Tests (Schritt 2).
 *
 * Zeiten sind Millisekunden seit Epoche (Instants). Intervalle sind halboffen
 * [start, ende): Ende = Start des nächsten Gastes ist KEINE Überschneidung.
 *
 * Buchung:
 *   { id, spotId, kind: 'reservation'|'spontaneous'|'block',
 *     start, plannedEnd, releasedAt|null, cancelledAt|null,
 *     arrivalConfirmedAt|null,            // Anwesenheit – getrennt von der Reservierung
 *     ownerId|null, name, contact, note, createdBy, createdAt }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Domain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SPOT_COUNT = 9;
  const KINDS = ['reservation', 'spontaneous', 'block'];
  const GRACE_PAST_MS = 60 * 1000; // Toleranz für "Beginn in der Vergangenheit"

  const fail = (error, extra) => Object.assign({ ok: false, error }, extra || {});
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  /** Tatsächliches Ende: frühzeitige Freigabe verkürzt, verlängert aber nie. */
  function effectiveEnd(b) {
    return b.releasedAt != null ? Math.min(b.releasedAt, b.plannedEnd) : b.plannedEnd;
  }

  /** Eine Buchung blockiert nur, solange sie nicht storniert und nicht leer ist. */
  function isActive(b) {
    return b.cancelledAt == null && effectiveEnd(b) > b.start;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function findConflicts(bookings, spotId, start, end, ignoreId) {
    return bookings.filter(
      (b) =>
        b.spotId === spotId &&
        b.id !== ignoreId &&
        isActive(b) &&
        overlaps(start, end, b.start, effectiveEnd(b))
    );
  }

  function nextId(bookings) {
    return bookings.reduce((m, b) => Math.max(m, b.id), 0) + 1;
  }

  const DAY_MS = 24 * 3600 * 1000;
  const pad2 = (n) => String(n).padStart(2, '0');

  /**
   * Prüft Kartenart gegen Zeitraum (Annahmen, vom Betreiber einstellbar):
   *  - tageskarte: Beginn und Ende im Zeitfenster tagVon–tagBis (Uhrzeit)
   *  - 24h: Dauer = 24 Stunden bzw. ein Vielfaches
   *  - jahreskarte: keine Zeitbeschränkung
   * cfg: { tagVon, tagBis, minutesOfDay? }
   */
  function cardError(card, start, end, cfg) {
    if (!card || card === 'jahreskarte' || !cfg) return null;
    const mod = cfg.minutesOfDay || ((ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); });
    if (card === 'tageskarte') {
      const a = cfg.tagVon * 60, z = cfg.tagBis * 60, s = mod(start), e = mod(end);
      if (s < a || s > z || e < a || e > z)
        return `Die Tageskarte gilt von ${pad2(cfg.tagVon)}:00 bis ${pad2(cfg.tagBis)}:00 Uhr – Beginn und Ende müssen in diesem Zeitfenster liegen (sonst die 24-Stunden-Karte wählen).`;
      return null;
    }
    if (card === '24h') {
      // nach Uhrzeit rechnen: Sa 12:00 → So 12:00 zählt auch bei Zeitumstellung als 24 Stunden
      const len = end - start + (new Date(start).getTimezoneOffset() - new Date(end).getTimezoneOffset()) * 60000;
      if (len <= 0 || len % DAY_MS !== 0)
        return 'Die 24-Stunden-Karte gilt genau 24 Stunden (bei mehreren Tagen ein Vielfaches davon, z. B. 48 Stunden).';
      return null;
    }
    return null;
  }

  function validateRange(spotId, start, end) {
    if (!Number.isInteger(spotId) || spotId < 1 || spotId > SPOT_COUNT)
      return 'Ungültiger Platz.';
    if (!isNum(start) || !isNum(end)) return 'Bitte Beginn und Ende angeben.';
    if (end <= start) return 'Das Ende muss nach dem Beginn liegen.';
    return null;
  }

  /**
   * Legt Reservierung, spontane Belegung oder Sperre an.
   * Gibt { ok, bookings, booking } oder { ok:false, error, conflicts } zurück.
   */
  function createBooking(bookings, input, now, opts) {
    opts = opts || {};
    const kind = input.kind || 'reservation';
    if (!KINDS.includes(kind)) return fail('Unbekannte Buchungsart.');
    const err = validateRange(input.spotId, input.start, input.end);
    if (err) return fail(err);
    if (kind === 'reservation' && !opts.allowPast && input.start < now - GRACE_PAST_MS)
      return fail('Der Beginn liegt in der Vergangenheit.');
    if (kind === 'reservation' && opts.maxDurationMs != null && input.end - input.start > opts.maxDurationMs)
      return fail(
        `Eine Reservierung darf höchstens ${Math.round(opts.maxDurationMs / 86400000)} Tage dauern.`,
        { tooLong: true }
      );
    if (kind === 'reservation' && opts.maxAdvanceMs != null && input.start > now + opts.maxAdvanceMs)
      return fail(
        `Reservierungen sind höchstens ${Math.round(opts.maxAdvanceMs / 86400000)} Tage im Voraus möglich.`,
        { tooFar: true }
      );
    if (kind === 'reservation' && opts.cardCfg) {
      const ce = cardError(input.card, input.start, input.end, opts.cardCfg);
      if (ce) return fail(ce, { badCard: true });
    }
    if (kind === 'reservation' && opts.isChangeover && !(opts.isChangeover(input.start) && opts.isChangeover(input.end)))
      return fail(`Beginn und Ende müssen zur festen Wechselzeit liegen${opts.changeoverText ? ' (' + opts.changeoverText + ')' : ''}.`, { badTime: true });
    if (kind === 'reservation' && opts.maxOpenPerUser != null && input.ownerId) {
      const open = countOpen(bookings, input.ownerId, now);
      if (open >= opts.maxOpenPerUser)
        return fail(`Es sind höchstens ${opts.maxOpenPerUser} offene Reservierungen gleichzeitig möglich (du hast bereits ${open}).`, { tooMany: true });
    }
    const conflicts = findConflicts(bookings, input.spotId, input.start, input.end);
    if (conflicts.length)
      return fail(
        `Platz ${input.spotId} ist im gewünschten Zeitraum nicht frei (belegt, reserviert oder gesperrt).`,
        { conflicts }
      );
    const booking = {
      id: nextId(bookings),
      spotId: input.spotId,
      kind,
      card: input.card || null,
      start: input.start,
      plannedEnd: input.end,
      releasedAt: null,
      cancelledAt: null,
      arrivalConfirmedAt: input.arrivalConfirmedAt != null ? input.arrivalConfirmedAt : null,
      ownerId: input.ownerId || null,
      name: input.name || '',
      contact: input.contact || '',
      note: input.note || '',
      createdBy: input.createdBy || null,
      createdAt: now,
    };
    return { ok: true, bookings: bookings.concat([booking]), booking };
  }

  /** Spätestes Ende einer spontanen Belegung: Beginn der nächsten Buchung. */
  function maxSpontaneousEnd(bookings, spotId, now) {
    const active = bookings.filter((b) => b.spotId === spotId && isActive(b));
    if (active.some((b) => b.start <= now && now < effectiveEnd(b))) return { blocked: true };
    const later = active.filter((b) => b.start > now).map((b) => b.start);
    return { blocked: false, maxEnd: later.length ? Math.min(...later) : null };
  }

  /** Spontan einen freien Platz ab jetzt bis zu einem geplanten Ende belegen. */
  function occupyNow(bookings, input, now, opts) {
    opts = opts || {};
    const err = validateRange(input.spotId, now, input.plannedEnd);
    if (err) return fail(err === 'Das Ende muss nach dem Beginn liegen.' ? 'Das Ende muss in der Zukunft liegen.' : err);
    if (opts.maxDurationMs != null && input.plannedEnd - now > opts.maxDurationMs)
      return fail(`Spontan belegen ist höchstens ${Math.round(opts.maxDurationMs / 3600000)} Stunden am Stück möglich.`, { tooLong: true });
    if (opts.cardCfg) {
      const ce = cardError(input.card, now, input.plannedEnd, opts.cardCfg);
      if (ce) return fail(ce, { badCard: true });
    }
    const st = spotStatus(bookings, input.spotId, now, now);
    if (st.state === 'ungeklaert')
      return fail('Die Belegung dieses Platzes ist ungeklärt – bitte zuerst beim Betreiber klären.');
    if (st.state !== 'frei') return fail('Der Platz ist gerade nicht frei.');
    const m = maxSpontaneousEnd(bookings, input.spotId, now);
    if (m.maxEnd != null && input.plannedEnd > m.maxEnd)
      return fail('Der Platz ist ab dem gewählten Ende bereits reserviert. Ein früheres Ende wählen.', {
        maxEnd: m.maxEnd,
      });
    return createBooking(
      bookings,
      {
        spotId: input.spotId,
        kind: 'spontaneous',
        card: input.card,
        start: now,
        end: input.plannedEnd,
        ownerId: input.ownerId,
        name: input.name,
        contact: input.contact,
        note: input.note,
        createdBy: input.createdBy,
        arrivalConfirmedAt: now, // Platz wird bewusst vor Ort belegt
      },
      now
    );
  }

  function patch(bookings, id, fn) {
    const i = bookings.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const copy = bookings.slice();
    copy[i] = fn(Object.assign({}, copy[i]));
    return { bookings: copy, booking: copy[i] };
  }

  /** Ankunft bestätigen (Anwesenheit). Nur während der geplanten Zeit. */
  function confirmArrival(bookings, id, now, opts) {
    opts = opts || {};
    const b = bookings.find((x) => x.id === id);
    if (!b || !isActive(b) || b.kind === 'block') return fail('Buchung nicht gefunden.');
    if (b.noShow) return fail('Die Reservierung wurde freigegeben, weil die Ankunft nicht rechtzeitig bestätigt wurde. Bitte den Betreiber kontaktieren.');
    if (b.arrivalConfirmedAt != null) return fail('Die Ankunft ist bereits bestätigt.');
    if (now < b.start && !opts.allowEarly) return fail('Die Reservierung hat noch nicht begonnen.');
    if (now >= effectiveEnd(b)) return fail('Das geplante Ende ist bereits überschritten.');
    return Object.assign({ ok: true }, patch(bookings, id, (x) => ((x.arrivalConfirmedAt = now), x)));
  }

  /** Reservierung vor Beginn stornieren. */
  function cancel(bookings, id, now, opts) {
    const b = bookings.find((x) => x.id === id);
    if (!b || b.cancelledAt != null) return fail('Buchung nicht gefunden.');
    if (b.start <= now) return fail('Die Buchung hat bereits begonnen – bitte den Platz freigeben.');
    const late = !!(opts && opts.lateMs != null && b.kind === 'reservation' && b.start - now < opts.lateMs);
    return Object.assign({ ok: true, late }, patch(bookings, id, (x) => ((x.cancelledAt = now), late && (x.lateCancel = true), x)));
  }

  /**
   * Platz frühzeitig freigeben / Belegung als beendet melden.
   * Klärt auch eine ungeklärte Belegung (Ende überschritten).
   */
  function release(bookings, id, now, by, opts) {
    const b = bookings.find((x) => x.id === id);
    if (!b || b.cancelledAt != null) return fail('Buchung nicht gefunden.');
    if (b.releasedAt != null) return fail('Der Platz wurde bereits freigegeben.');
    if (b.start > now) return cancel(bookings, id, now, opts);
    return Object.assign(
      { ok: true },
      patch(bookings, id, (x) => ((x.releasedAt = now), (x.releasedBy = by || null), x))
    );
  }

  /** Betreiber-Korrektur (Zeit, Platz, Angaben) mit erneuter Konfliktprüfung. */
  function updateBooking(bookings, id, changes, now) {
    const b = bookings.find((x) => x.id === id);
    if (!b) return fail('Buchung nicht gefunden.');
    const next = Object.assign({}, b, changes);
    const err = validateRange(next.spotId, next.start, next.plannedEnd);
    if (err) return fail(err);
    // Eine Korrektur setzt eine frühere Freigabe zurück, wenn das Ende neu gesetzt wird
    if (changes.plannedEnd != null && changes.releasedAt === undefined && b.releasedAt != null)
      next.releasedAt = null;
    if (next.cancelledAt == null) {
      const conflicts = findConflicts(bookings, next.spotId, next.start, effectiveEnd(next), id);
      if (conflicts.length)
        return fail(`Platz ${next.spotId} ist im geänderten Zeitraum nicht frei.`, { conflicts });
    }
    return Object.assign({ ok: true }, patch(bookings, id, () => next));
  }

  /** Laufende Belegung verlängern (nur wenn der Platz danach frei ist). */
  function extend(bookings, id, newEnd, now, opts) {
    opts = opts || {};
    const b = bookings.find((x) => x.id === id);
    if (!b || !isActive(b) || b.kind === 'block') return fail('Buchung nicht gefunden.');
    if (b.releasedAt != null) return fail('Der Platz wurde bereits freigegeben.');
    if (b.start > now || now >= effectiveEnd(b)) return fail('Verlängern ist nur während der laufenden Belegung möglich.');
    if (!isNum(newEnd) || newEnd <= b.plannedEnd) return fail('Das neue Ende muss nach dem bisherigen Ende liegen.');
    if (opts.maxDurationMs != null && newEnd - b.start > opts.maxDurationMs)
      return fail(`Die Gesamtdauer darf höchstens ${opts.maxDurationText || Math.round(opts.maxDurationMs / 3600000) + ' Stunden'} betragen.`, { tooLong: true });
    if (opts.cardCfg) {
      const ce = cardError(b.card, b.start, newEnd, opts.cardCfg);
      if (ce) return fail(ce, { badCard: true });
    }
    const conflicts = findConflicts(bookings, b.spotId, b.start, newEnd, id);
    if (conflicts.length)
      return fail('Der Platz ist danach bereits reserviert. Ein früheres Ende wählen.', {
        conflicts,
        maxEnd: Math.min(...conflicts.map((c) => c.start)),
      });
    return Object.assign({ ok: true }, patch(bookings, id, (x) => ((x.plannedEnd = newEnd), x)));
  }

  /** Offene (noch nicht beendete, nicht freigegebene) Reservierungen einer Person. */
  function countOpen(bookings, ownerId, now) {
    return bookings.filter(
      (b) => b.ownerId === ownerId && b.kind === 'reservation' && b.cancelledAt == null && b.releasedAt == null && b.plannedEnd > now
    ).length;
  }

  /**
   * Karenzzeit: Reservierungen ohne Ankunftsbestätigung werden `graceMs` nach Beginn
   * automatisch freigegeben (Vermerk noShow). Gibt die geänderten Buchungs-IDs zurück.
   */
  function applyNoShows(bookings, now, graceMs) {
    const affected = [];
    const out = bookings.map((b) => {
      if (b.kind === 'reservation' && b.cancelledAt == null && b.releasedAt == null && b.arrivalConfirmedAt == null && !b.noShow && now >= b.start + graceMs) {
        affected.push(b.id);
        return Object.assign({}, b, { releasedAt: b.start + graceMs, noShow: true });
      }
      return b;
    });
    return { bookings: out, affected };
  }

  /** Nicht angetreten: automatisch freigegeben oder ohne Bestätigung beendet. */
  function isNoShow(b, now) {
    return (
      b.kind === 'reservation' && b.cancelledAt == null && b.arrivalConfirmedAt == null &&
      (!!b.noShow || (b.releasedAt == null && b.plannedEnd <= now))
    );
  }

  /**
   * Zustand eines Platzes zum Zeitpunkt t.
   *   frei | reserviert (Ankunft offen) | anwesend (bestätigt) | gesperrt | ungeklaert
   * "ungeklaert": geplantes Ende überschritten, Anwesenheit war bestätigt,
   * aber weder Freigabe noch Räumung gemeldet. Wird nur für t <= now bewertet.
   */
  function spotStatus(bookings, spotId, t, now) {
    const mine = bookings.filter((b) => b.spotId === spotId && b.cancelledAt == null);
    const active = mine.filter(isActive);
    const current = active.find((b) => b.start <= t && t < effectiveEnd(b)) || null;
    const overdue =
      t <= now
        ? mine
            .filter(
              (b) =>
                b.kind !== 'block' &&
                b.releasedAt == null &&
                b.arrivalConfirmedAt != null &&
                b.plannedEnd <= t
            )
            .sort((a, b) => b.plannedEnd - a.plannedEnd)[0] || null
        : null;
    const upcoming = active.filter((b) => b.start > t).sort((a, b) => a.start - b.start)[0] || null;

    let state;
    if (current && current.kind === 'block') state = 'gesperrt';
    else if (current) state = current.arrivalConfirmedAt != null && current.arrivalConfirmedAt <= now ? 'anwesend' : 'reserviert';
    else if (overdue) state = 'ungeklaert';
    else state = 'frei';

    return {
      state,
      booking: current,
      overdue, // gesetzt auch dann, wenn bereits ein Folgegast dran ist (Warnung)
      next: upcoming,
      freeUntil: state === 'frei' ? (upcoming ? upcoming.start : null) : null,
    };
  }

  /** Welche Plätze sind im gesamten Zeitraum frei? */
  function availabilityForPeriod(bookings, start, end, now) {
    const out = [];
    for (let spotId = 1; spotId <= SPOT_COUNT; spotId++) {
      const conflicts = findConflicts(bookings, spotId, start, end);
      const st = spotStatus(bookings, spotId, Math.min(now, end), now);
      out.push({ spotId, free: conflicts.length === 0, conflicts, unclear: st.state === 'ungeklaert' });
    }
    return out;
  }

  /** Öffentliche Sicht: nur Verfügbarkeit, keinerlei personenbezogene Felder. */
  function publicView(bookings, t, now) {
    const spots = [];
    for (let spotId = 1; spotId <= SPOT_COUNT; spotId++) {
      const st = spotStatus(bookings, spotId, t, now);
      spots.push({
        spotId,
        state: st.state,
        until: st.booking ? effectiveEnd(st.booking) : st.state === 'frei' ? st.freeUntil : null,
        overdueSince: st.overdue ? st.overdue.plannedEnd : null,
      });
    }
    const intervals = bookings
      .filter(isActive)
      .map((b) => ({
        spotId: b.spotId,
        start: b.start,
        end: effectiveEnd(b),
        kind: b.kind === 'block' ? 'gesperrt' : 'belegt',
      }));
    return { spots, intervals };
  }

  return {
    SPOT_COUNT,
    effectiveEnd,
    cardError,
    isActive,
    overlaps,
    findConflicts,
    createBooking,
    maxSpontaneousEnd,
    occupyNow,
    confirmArrival,
    cancel,
    release,
    updateBooking,
    extend,
    countOpen,
    applyNoShows,
    isNoShow,
    spotStatus,
    availabilityForPeriod,
    publicView,
  };
});
