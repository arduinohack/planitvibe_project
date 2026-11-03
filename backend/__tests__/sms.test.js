const { sendSms } = require('../utils/sms');

const originalFetch = global.fetch;
const envSnapshot = {
  SMS_PROVIDER: process.env.SMS_PROVIDER,
  TEXTBELT_KEY: process.env.TEXTBELT_KEY,
};

let logs;

beforeEach(() => {
  process.env.SMS_PROVIDER = 'console';
  delete process.env.TEXTBELT_KEY;
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((message) => logs.push(String(message)));
  jest.spyOn(console, 'error').mockImplementation((message) => logs.push(String(message)));
  global.fetch = jest.fn(() => {
    throw new Error('fetch should not be called');
  });
});

afterEach(() => {
  if (envSnapshot.SMS_PROVIDER === undefined) delete process.env.SMS_PROVIDER;
  else process.env.SMS_PROVIDER = envSnapshot.SMS_PROVIDER;
  if (envSnapshot.TEXTBELT_KEY === undefined) delete process.env.TEXTBELT_KEY;
  else process.env.TEXTBELT_KEY = envSnapshot.TEXTBELT_KEY;
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function loggedText() {
  return logs.join('\n');
}

describe('sendSms', () => {
  test('console logs the destination and body length and does not call the network', async () => {
    process.env.TEXTBELT_KEY = 'fake-key';

    await sendSms({ to: '5551234567', body: 'Hello from PlanItVibe' });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(loggedText()).toContain('to +15551234567');
    expect(loggedText()).toContain('length 21');
    expect(loggedText()).not.toContain('fake-key');
  });

  test('a blank provider is console', async () => {
    process.env.SMS_PROVIDER = '   ';

    await sendSms({ to: '+15551234567', body: 'Hi' });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(loggedText()).toContain('SMS console provider: to +15551234567');
  });

  test('textbelt posts the normalized phone and does not log the key', async () => {
    process.env.SMS_PROVIDER = 'textbelt';
    process.env.TEXTBELT_KEY = 'fake-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, quotaRemaining: 9 }),
    });

    await sendSms({ to: '(555) 123-4567', body: 'Invite accepted.' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('https://textbelt.com/text', expect.objectContaining({
      method: 'POST',
    }));
    const request = global.fetch.mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual({
      phone: '+15551234567',
      message: 'Invite accepted.',
      key: 'fake-key',
    });
    expect(loggedText()).toContain('SMS sent via textbelt');
    expect(loggedText()).toContain('quotaRemaining 9');
    expect(loggedText()).not.toContain('fake-key');
  });

  test('a number that already starts with + is sent unchanged', async () => {
    process.env.SMS_PROVIDER = 'textbelt';
    process.env.TEXTBELT_KEY = 'fake-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, quotaRemaining: 1 }),
    });

    await sendSms({ to: '+44 20 7946 0958', body: 'Hi' });

    expect(JSON.parse(global.fetch.mock.calls[0][1].body).phone).toBe('+44 20 7946 0958');
  });

  test('an empty Textbelt key skips the request', async () => {
    process.env.SMS_PROVIDER = 'textbelt';
    process.env.TEXTBELT_KEY = '   ';

    await expect(sendSms({ to: '+15551234567', body: 'Hi' })).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(loggedText()).toContain('TEXTBELT_KEY is empty');
  });

  test('a Textbelt failure is logged and does not throw', async () => {
    process.env.SMS_PROVIDER = 'textbelt';
    process.env.TEXTBELT_KEY = 'fake-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ success: false, error: 'Out of quota', quotaRemaining: 0 }),
    });

    await expect(sendSms({ to: '+15551234567', body: 'Hi' })).resolves.toBeUndefined();

    const text = loggedText();
    expect(text).toContain('SMS failed: provider textbelt');
    expect(text).toContain('status 403');
    expect(text).toContain('error Out of quota');
    expect(text).toContain('success false');
    expect(text).toContain('quotaRemaining 0');
    expect(text).not.toContain('fake-key');
  });

  test('an unknown provider is skipped', async () => {
    process.env.SMS_PROVIDER = 'pigeon';

    await expect(sendSms({ to: '+15551234567', body: 'Hi' })).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(loggedText()).toContain('provider pigeon is unknown');
  });
});
