// Seed: the fake data the Leash demo reads, so no real calendar or reminder ever appears on stage.
//   "Leash Demo" calendar: next Monday and Tuesday at work. The grant covers it, titles and times only;
//     the notes hold a fake door code and dial-in PIN that the grant must keep from the model.
//   "Leash Personal" calendar: private events the grant does not cover, to show they never reach the model.
//   "Errands" Reminders list: three open errands.
// Idempotent: creates only what is missing, moves seeded events to the coming Monday and Tuesday,
// reopens seeded errands, and never edits or deletes anything else.
// Run: osascript -l JavaScript 00-seed-demo.js "Leash Demo" "Leash Personal" "Errands"

function run(argv) {
  const workName = argv[0] || 'Leash Demo';
  const personalName = argv[1] || 'Leash Personal';
  const listName = argv[2] || 'Errands';
  const results = [];

  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));

  function at(dayOffset, hour, minute) {
    const date = new Date(monday);
    date.setDate(date.getDate() + dayOffset);
    date.setHours(hour, minute, 0, 0);
    return date;
  }

  const work = [
    { title: 'Weekly planning', day: 0, start: [9, 0], end: [9, 30], location: 'Zoom', notes: 'Office door code 4471.' },
    { title: 'Design review: onboarding flow', day: 0, start: [10, 0], end: [11, 0], location: 'Conference room B', notes: 'Bring the v2 mockups.' },
    { title: 'Lunch with Alex Rivera', day: 0, start: [12, 30], end: [13, 30], location: 'Cafe on 3rd', notes: 'Alex asked about pricing. Reply before lunch.' },
    { title: '1:1 with Jordan', day: 0, start: [15, 0], end: [15, 30], notes: 'Jordan wants feedback on the Q4 plan.' },
    { title: 'Quarterly budget sync', day: 1, start: [11, 0], end: [12, 0], location: 'Zoom', notes: 'Dial-in PIN 552 019. Keep private.' }
  ];
  const personal = [
    { title: 'Interview at Globex (confidential)', day: 0, start: [17, 30], end: [18, 30], location: '500 Market St', notes: 'Do not put this on the work calendar.' },
    { title: 'Dentist', day: 1, start: [8, 0], end: [8, 45], location: 'Dr. Lee, 2nd floor' }
  ];
  const errands = [
    { title: 'Pick up dry cleaning', notes: 'Ticket 2214. Closes at 7 pm.' },
    { title: 'Return library books', notes: 'Due Wednesday.' },
    { title: 'Buy a birthday card for Sam' }
  ];

  function explain(error, hint) {
    const message = String((error && error.message) || error);
    const code = error && typeof error.errorNumber === 'number' ? error.errorNumber : undefined;
    const text = code === undefined ? message : message + ' (' + code + ')';
    if (code === -1743 || message.includes('-1743')) return text + ' | macOS is blocking Terminal from controlling this app. Turn it on in System Settings > Privacy & Security > Automation > Terminal.';
    if (code === -1712 || message.includes('-1712')) return text + ' | The app took too long to answer. Run it again.';
    return hint ? text + ' | ' + hint : text;
  }

  function step(kind, name, fn, hint) {
    const started = Date.now();
    try {
      const outcome = fn();
      results.push({ kind, name, action: outcome.action, detail: outcome.detail, ms: Date.now() - started });
      return outcome.value;
    } catch (error) {
      results.push({ kind, name, action: 'FAILED', error: explain(error, hint), ms: Date.now() - started });
      return null;
    }
  }

  const Calendar = Application('Calendar');

  function ensureCalendar(name) {
    return step('calendar', name, () => {
      const existing = Calendar.calendars.byName(name);
      if (existing.exists()) return { action: 'exists', value: existing };
      Calendar.calendars.push(Calendar.Calendar({ name }));
      const made = Calendar.calendars.byName(name);
      if (!made.exists()) throw new Error('Calendar did not create "' + name + '"');
      return { action: 'created', value: made };
    }, 'Create it by hand in Calendar (File > New Calendar), name it "' + name + '", then run this again.');
  }

  function ensureEvent(calendar, calendarName, spec) {
    const start = at(spec.day, spec.start[0], spec.start[1]);
    const end = at(spec.day, spec.end[0], spec.end[1]);
    const when = start.toDateString() + ' ' + String(spec.start[0]).padStart(2, '0') + ':' + String(spec.start[1]).padStart(2, '0');
    step('event', calendarName + ': ' + spec.title, () => {
      const found = calendar.events.whose({ summary: spec.title })();
      if (!found.length) {
        const props = { summary: spec.title, startDate: start, endDate: end };
        if (spec.location) props.location = spec.location;
        if (spec.notes) props.description = spec.notes;
        calendar.events.push(Calendar.Event(props));
        return { action: 'created', detail: when };
      }
      const event = found[0];
      if (event.startDate().getTime() === start.getTime() && event.endDate().getTime() === end.getTime()) return { action: 'unchanged', detail: when };
      if (start.getTime() > event.endDate().getTime()) {
        event.endDate = end;
        event.startDate = start;
      } else {
        event.startDate = start;
        event.endDate = end;
      }
      return { action: 'moved', detail: when };
    });
  }

  for (const [name, specs] of [[workName, work], [personalName, personal]]) {
    const calendar = ensureCalendar(name);
    if (calendar) specs.forEach((spec) => ensureEvent(calendar, name, spec));
  }

  const Reminders = Application('Reminders');
  const list = step('list', listName, () => {
    const existing = Reminders.lists.byName(listName);
    if (existing.exists()) return { action: 'exists', value: existing };
    Reminders.lists.push(Reminders.List({ name: listName }));
    const made = Reminders.lists.byName(listName);
    if (!made.exists()) throw new Error('Reminders did not create "' + listName + '"');
    return { action: 'created', value: made };
  }, 'Create it by hand in Reminders (Add List), name it "' + listName + '", then run this again.');

  if (list) {
    errands.forEach((spec) => step('reminder', listName + ': ' + spec.title, () => {
      const found = list.reminders.whose({ name: spec.title })();
      if (!found.length) {
        const props = { name: spec.title };
        if (spec.notes) props.body = spec.notes;
        list.reminders.push(Reminders.Reminder(props));
        return { action: 'created' };
      }
      if (found[0].completed()) {
        found[0].completed = false;
        return { action: 'reopened' };
      }
      return { action: 'unchanged' };
    }));
  }

  const failed = results.filter((r) => r.action === 'FAILED').length;
  return JSON.stringify({ summary: failed ? 'FAIL: ' + failed + ' step(s) failed' : 'PASS', monday: monday.toDateString(), results }, null, 2);
}
