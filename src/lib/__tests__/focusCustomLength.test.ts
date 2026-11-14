// Focus timer Custom length (Zakria 2026-11-14): focus from FOCUS_MIN_MINUTES (the minimum that
// saves a session and earns points) up to 600, break up to 120. A custom focus below the minimum
// is refused before Start, so no session that can never save is started.
const S = await import('../focus/focusSession');
const { FOCUS_MIN_MINUTES } = await import('../points/focusPoints');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const tooShort = `Focus needs at least ${FOCUS_MIN_MINUTES} min.`;
const p = S.customLengthProblem;

// Below the minimum: refused (blocks Start), whatever the break.
eq(p(1, 5), tooShort, 'custom 1 min is refused');
eq(p(10, 5), tooShort, 'custom 10 min is refused');
eq(p(FOCUS_MIN_MINUTES - 1, 5), tooShort, 'one minute under the minimum is refused');
eq(p(0, 5), tooShort, '0 is refused');
eq(p(-5, 5), tooShort, 'a negative length is refused');
eq(p(Number.NaN, 5), tooShort, 'an empty / unreadable field is refused');
eq(p(10, 500), tooShort, 'the focus problem comes first');

// The minimum and above start.
eq(p(FOCUS_MIN_MINUTES, 5), null, 'the minimum starts');
eq(p(FOCUS_MIN_MINUTES, 1), null, 'the minimum with a 1-min break starts');
eq(p(75, 15), null, 'a normal custom length starts');

// Upper limits unchanged.
eq(p(S.CUSTOM_FOCUS_MAX, S.CUSTOM_BREAK_MAX), null, 'both maxima start');
eq(p(S.CUSTOM_FOCUS_MAX + 1, 5), `Focus can be up to ${S.CUSTOM_FOCUS_MAX} min.`, 'over the focus max is refused');
eq(p(60, S.CUSTOM_BREAK_MAX + 1), `Break can be up to ${S.CUSTOM_BREAK_MAX} min.`, 'over the break max is refused');
eq(S.CUSTOM_FOCUS_MAX, 600, 'focus max matches the server (least(600, …))');
eq(S.CUSTOM_BREAK_MAX, 120, 'break max matches the server (least(120, …))');

// The minimum is the one that saves a session; every preset is at or above it.
eq(FOCUS_MIN_MINUTES, 25, 'minimum is 25 min');
eq(S.FOCUS_MIN_MINUTES_TO_SAVE, FOCUS_MIN_MINUTES, 'custom minimum = minimum that saves');
for (const preset of S.FOCUS_PRESETS) assert(p(preset.focus, preset.break) === null, `preset ${preset.focus}/${preset.break} passes the custom rule`);

console.log('focusCustomLength: all assertions passed');
