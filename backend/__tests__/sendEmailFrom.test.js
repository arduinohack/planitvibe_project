const { selectedFrom } = require('../utils/email/sendEmail');

describe('selectedFrom', () => {
  const snapshot = process.env.EMAIL_FROM;

  afterEach(() => {
    if (snapshot === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = snapshot;
  });

  test('uses PlanItVibe when EMAIL_FROM has a display name', () => {
    process.env.EMAIL_FROM = 'Planner <mail@mail.eratespecialists.com>';
    expect(selectedFrom()).toBe('PlanItVibe <mail@mail.eratespecialists.com>');
  });

  test('uses PlanItVibe when EMAIL_FROM is only an address', () => {
    process.env.EMAIL_FROM = 'mail@mail.eratespecialists.com';
    expect(selectedFrom()).toBe('PlanItVibe <mail@mail.eratespecialists.com>');
  });

  test('keeps the fallback address and names it PlanItVibe', () => {
    delete process.env.EMAIL_FROM;
    expect(selectedFrom()).toBe('PlanItVibe <ken@eratespecialists.com>');
  });

  test('does not send the EMAIL_FROM display name', () => {
    process.env.EMAIL_FROM = '"Planner" <noreply@mail.eratespecialists.com>';
    const from = selectedFrom();
    expect(from).toBe('PlanItVibe <noreply@mail.eratespecialists.com>');
    expect(from).not.toMatch(/Planner/);
  });
});
