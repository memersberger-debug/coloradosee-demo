/* Demo-Speicher: localStorage + Beispieldaten. In Schritt 2 durch die zentrale Datenbank ersetzt. */
(function (root) {
  'use strict';
  const KEY = 'coloradosee-demo-v5';
  const H = 3600 * 1000;
  const DAY = 24 * H;

  /** Beispieldaten relativ zu "jetzt" (auf volle Stunde gerundet). */
  function seed() {
    const now = Math.floor(Date.now() / H) * H;
    let id = 0;
    const b = (spotId, kind, start, end, extra) =>
      Object.assign(
        {
          id: ++id, spotId, kind, card: kind === 'block' ? null : 'tageskarte', start, plannedEnd: end,
          releasedAt: null, cancelledAt: null, arrivalConfirmedAt: null,
          ownerId: null, name: '', contact: '', note: '', createdBy: null, createdAt: now - 3 * DAY,
        },
        extra
      );
    const bookings = [
      // 1: mehrtägig, Ankunft bestätigt → anwesend
      b(1, 'reservation', now - 20 * H, now + 30 * H, { ownerId: 'max', card: 'jahreskarte', name: 'Max Muster', createdBy: 'max', arrivalConfirmedAt: now - 19 * H }),
      // 2: beginnt in 3 Stunden, mehrtägig, Ankunft noch offen
      b(2, 'reservation', now + 3 * H, now + 3 * H + 2 * DAY, { card: '24h', ownerId: 'erika', name: 'Erika Beispiel', createdBy: 'erika' }),
      // 3: jetzt frei, aber in 20 Stunden reserviert → spontane Belegung nur bis dahin
      b(3, 'reservation', now + 20 * H, now + 20 * H + DAY, { card: '24h', ownerId: 'erika', name: 'Erika Beispiel', createdBy: 'erika' }),
      // 4: geplantes Ende überschritten, Anwesenheit bestätigt, nicht freigegeben → ungeklärt
      b(4, 'reservation', now - 30 * H, now - 2 * H, { ownerId: 'erika', name: 'Erika Beispiel', createdBy: 'erika', arrivalConfirmedAt: now - 29 * H }),
      // 5: gesperrt
      b(5, 'block', now - DAY, now + 3 * DAY, { name: 'Sperre', note: 'Beispiel: Wartung', createdBy: 'betreiber' }),
      // 7: Zukunft, Max
      b(7, 'reservation', now + 5 * DAY, now + 7 * DAY, { ownerId: 'max', card: 'jahreskarte', name: 'Max Muster', createdBy: 'max' }),
      // 8: spontan belegt
      b(8, 'spontaneous', now - 2 * H, now + 4 * H, { ownerId: 'erika', name: 'Erika Beispiel', createdBy: 'erika', arrivalConfirmedAt: now - 2 * H }),
      // 9: frühere Freigabe (Historie) + telefonische Buchung in 2 Tagen
      b(9, 'reservation', now - 2 * DAY, now - DAY, { ownerId: 'max', card: 'jahreskarte', name: 'Max Muster', createdBy: 'max', arrivalConfirmedAt: now - 2 * DAY + H, releasedAt: now - DAY - 5 * H, releasedBy: 'max' }),
      b(9, 'reservation', now + 2 * DAY, now + 3 * DAY + 12 * H, { name: 'Telefonbuchung Beispiel', contact: '0664 0000000', createdBy: 'betreiber' }),
    ];
    const yr = new Date(now).getFullYear();
    const users = [
      { id: 'max', name: 'Max Muster', email: 'max@example.invalid', type: 'jahreskarte', status: 'aktiv', season: yr, createdAt: now - 30 * DAY },
      { id: 'erika', name: 'Erika Beispiel', email: 'erika@example.invalid', type: 'registriert', status: 'aktiv', season: yr, createdAt: now - 10 * DAY },
      { id: 'berta', name: 'Berta Altgast', email: 'berta@example.invalid', type: 'registriert', status: 'aktiv', season: yr - 1, createdAt: now - 400 * DAY },
      { id: 'hans', name: 'Hans Neuling', email: 'hans@example.invalid', type: 'registriert', status: 'wartet', season: yr, createdAt: now - 2 * H },
    ];
    users.forEach((u) => { u.consentAt = u.createdAt; });
    // Betriebsregeln: alle Zahlen sind VORSCHLÄGE und vom Betreiber unter „Regeln“ änderbar.
    // Leer/0 = Regel aus. (maxAdvanceDays 14 und maxDurationDays 5 hat der Betreiber vorgegeben.)
    const settings = {
      operatorEmail: 'erwin.schuster@example.invalid', // Platzhalter – echte Adresse eintragen
      tageskarteVon: 5, // laut Homepage: Fischen 5:00–22:00 Uhr
      tageskarteBis: 22,
      maxAdvanceDays: 14,
      maxDurationDays: 5,
      maxOpenReservations: 2,
      graceHours: 3,
      maxSpontaneousHours: 48,
      cancelDeadlineHours: 24,
      warnCount: 3,
      changeoverHour: null,
      reminderHours: 24,
    };
    const spots = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: 'Platz ' + (i + 1), note: i === 1 ? 'Beispielhinweis (Demo): Platz nur zu Fuß erreichbar.' : '' }));
    return { bookings, users, settings, spots, mails: [], log: [], clockOffset: 0, who: 'gast' };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.bookings) && Array.isArray(d.users) && d.settings && Array.isArray(d.spots)) return d;
      }
    } catch (e) { /* localStorage nicht verfügbar → Demo läuft ohne Speicherung */ }
    return seed();
  }

  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignorieren */ }
  }

  root.Store = { load, save, seed };
})(window);
