// Spike 01: how fast are the reads Leash depends on, on this Mac, on macOS 27?
// Read-only. Prints names, counts and timings; never prints event titles or email bodies.
// Run: osascript -l JavaScript 01-read-timing.js Alumni "Leash Demo"

function run(argv) {
  const mailAccount = argv[0] || 'Alumni';
  const mailLabel = argv[1] || 'Leash Demo';
  const slowMs = 3000;
  const results = [];

  function explain(message, code) {
    const text = code === undefined ? message : message + ' (' + code + ')';
    if (code === -1743 || message.includes('-1743')) return text + ' | macOS is blocking Terminal from controlling this app. Turn it on in System Settings > Privacy & Security > Automation > Terminal.';
    if (code === -1712 || message.includes('-1712')) return text + ' | The app took too long to answer.';
    if (code === -1728 || message.includes('-1728')) return text + ' | Not found (check the account, mailbox or list name).';
    if (code === -600) return text + ' | The app is not running and could not be launched.';
    return text;
  }

  function step(name, fn) {
    const started = Date.now();
    try {
      const value = fn();
      const ms = Date.now() - started;
      results.push({ step: name, ms, verdict: ms > slowMs ? 'SLOW' : 'ok', value });
    } catch (error) {
      const code = error && typeof error.errorNumber === 'number' ? error.errorNumber : undefined;
      results.push({ step: name, ms: Date.now() - started, verdict: 'FAILED', error: explain(String((error && error.message) || error), code) });
    }
  }

  const Calendar = Application('Calendar');
  step('calendar: list calendars', () => Calendar.calendars.name());
  step('calendar: events in the next 7 days, per calendar', () => {
    const start = new Date();
    const end = new Date(Date.now() + 7 * 864e5);
    return Calendar.calendars().map((calendar) => {
      const t = Date.now();
      const count = calendar.events.whose({ startDate: { _lessThanEquals: end }, endDate: { _greaterThanEquals: start } })().length;
      return { calendar: calendar.name(), events: count, ms: Date.now() - t };
    });
  });

  const Reminders = Application('Reminders');
  step('reminders: list lists', () => Reminders.lists.name());
  step('reminders: open items per list', () => Reminders.lists().map((list) => {
    const t = Date.now();
    const open = list.reminders.whose({ completed: false }).name().length;
    return { list: list.name(), open, ms: Date.now() - t };
  }));

  const Mail = Application('Mail');
  const local = mailAccount === 'On My Mac' || mailAccount === 'local';
  const mailboxesOf = () => (local ? Mail.mailboxes : Mail.accounts.byName(mailAccount).mailboxes);
  step('mail: accounts', () => Mail.accounts.name());
  step('mail: mailboxes in ' + mailAccount + (local ? ' (local folders)' : ' (Gmail labels show up here)'), () => mailboxesOf().name());
  step('mail: first 5 messages in "' + mailLabel + '"', () => {
    const box = mailboxesOf().byName(mailLabel);
    if (!box.exists()) throw new Error('Mailbox not found: ' + mailLabel + ' (-1728)');
    const count = box.messages.length; return (count ? box.messages.slice(0, Math.min(count, 5) - 1)() : []).map((message) => ({ from: message.sender(), subject: message.subject() }));
  });
  step('mail: read one message body in "' + mailLabel + '" (length only)', () => {
    const box = mailboxesOf().byName(mailLabel);
    if (!box.exists()) throw new Error('Mailbox not found: ' + mailLabel + ' (-1728)');
    const newest = box.messages.slice(0, 0)();
    return newest.length ? { characters: String(newest[0].content() || '').length } : { characters: 0, note: 'mailbox is empty' };
  });

  const slow = results.filter((r) => r.verdict === 'SLOW').length;
  const failed = results.filter((r) => r.verdict === 'FAILED').length;
  return JSON.stringify({ summary: failed ? 'FAIL: ' + failed + ' step(s) failed' : slow ? 'WARN: ' + slow + ' step(s) slower than 3 s' : 'PASS', results }, null, 2);
}
