jest.mock('../utils/email/sendEmail', () => ({
  sendEmail: jest.fn().mockResolvedValue({ id: 'email_1' }),
  selectedProviderName: jest.fn(() => 'console'),
  selectedFrom: jest.fn(() => 'PlanItVibe <ken@eratespecialists.com>'),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const { allowRegister, clearRegisterInvite } = require('./inviteForRegister');
const User = require('../models/User');
const Plan = require('../models/Plan');
const PlanUser = require('../models/PlanUser');
const Invitation = require('../models/Invitation');
const { Event } = require('../models/Event');
const PublishedTemplate = require('../models/PublishedTemplate');
const TemplateReport = require('../models/TemplateReport');
const SupportLog = require('../models/SupportLog');
const { sendEmail } = require('../utils/email/sendEmail');
const { sendOpenReportDigest } = require('../utils/templateReports');

jest.setTimeout(30000);

let mongo;

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndLogin(email, firstName) {
  await allowRegister(email);
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({
      firstName,
      lastName: 'Lovelace',
      email,
      password: 'password1',
    });
  await clearRegisterInvite(email);
  expect(registerRes.status).toBe(201);
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'password1' });
  expect(loginRes.status).toBe(200);
  return { token: loginRes.body.token, userId: loginRes.body.user._id };
}

async function setTier(userId, tier) {
  await User.updateOne({ _id: userId }, { $set: { tier, plusActive: true } });
}

async function createPlan(token, name) {
  const res = await request(app)
    .post('/api/plans')
    .set(bearer(token))
    .send({
      type: 'trip',
      name,
      destination: 'Lisbon',
      timeZone: 'UTC',
    });
  expect(res.status).toBe(201);
  return res.body.plan._id;
}

function publishBody(title) {
  return {
    title,
    description: 'A short city walk',
    city: 'Lisbon',
    tripLength: 3,
    vibe: 'Slow',
    coverImage: 'https://example.com/lisbon.jpg',
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  sendEmail.mockClear();
  await Promise.all([
    User.deleteMany({}),
    Plan.deleteMany({}),
    PlanUser.deleteMany({}),
    Invitation.deleteMany({}),
    Event.deleteMany({}),
    PublishedTemplate.deleteMany({}),
    TemplateReport.deleteMany({}),
    SupportLog.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe('published templates', () => {
  test('publish strips private fields, and a copy keeps its own dates', async () => {
    const ada = await registerAndLogin('ada-publish@example.com', 'Ada');
    await setTier(ada.userId, 'plus');
    const planId = await createPlan(ada.token, 'Lisbon trip');
    await request(app)
      .post('/api/activities')
      .set(bearer(ada.token))
      .send({
        type: 'flight',
        planId,
        name: 'DL 961',
        bookingReference: 'ABC123',
        confirmation: 'CONF999',
        location: '123 Secret Street',
        googlePlaceId: 'ChIJtestplace',
        details: 'Email ada@secret.test about the seat',
        startTime: '2030-06-02T10:00:00.000Z',
        endTime: '2030-06-02T12:00:00.000Z',
      });
    const dinner = await request(app)
      .post('/api/activities')
      .set(bearer(ada.token))
      .send({
        type: 'dining',
        planId,
        name: 'Dinner',
        details: 'Ask for a window',
        startTime: '2030-06-02T19:00:00.000Z',
        endTime: '2030-06-02T21:00:00.000Z',
      });
    expect(dinner.status).toBe(201);

    const preview = await request(app)
      .post(`/api/published-templates/from/${planId}/preview`)
      .set(bearer(ada.token))
      .send(publishBody('3 days in Lisbon'));
    expect(preview.status).toBe(200);
    expect(preview.body.blocked).toBeNull();
    expect(preview.body.removed.join('\n')).toContain('Booking reference removed');
    expect(preview.body.removed.join('\n')).toContain('Private note removed');
    expect(preview.body.removed).toContain('Original calendar dates are not shown.');
    expect(JSON.stringify(preview.body)).not.toContain('ABC123');
    expect(JSON.stringify(preview.body)).not.toContain('2030-06-02');
    const dinnerStop = preview.body.preview.stops.find((stop) => stop.name === 'Dinner');
    expect(dinnerStop.details).toBe('Ask for a window');
    expect(dinnerStop.day).toBe(1);
    expect(dinnerStop.start).toBe('19:00');

    const published = await request(app)
      .post(`/api/published-templates/from/${planId}`)
      .set(bearer(ada.token))
      .send(publishBody('3 days in Lisbon'));
    expect(published.status).toBe(201);
    const templateId = published.body.template.id;
    expect(published.body.template.creatorName).toBe('Ada Lovelace');
    expect(published.body.template.sharePath).toBe(`/template.html?id=${templateId}`);

    const stored = await PublishedTemplate.findById(templateId).lean();
    expect(JSON.stringify(stored.activities)).not.toContain('ABC123');
    expect(JSON.stringify(stored.activities)).not.toContain('CONF999');
    expect(JSON.stringify(stored.activities)).not.toContain('Secret Street');

    const open = await request(app).get('/api/public/templates');
    expect(open.status).toBe(200);
    expect(open.body.templates.map((row) => row.title)).toEqual(['3 days in Lisbon']);

    const page = await request(app).get(`/api/public/templates/${templateId}`);
    expect(page.status).toBe(200);
    expect(page.body.template.viewCount).toBe(1);
    expect(JSON.stringify(page.body)).not.toContain('ada@secret.test');
    expect(page.body.template.stops.some((stop) => stop.name === 'DL 961')).toBe(true);

    const grace = await registerAndLogin('grace-copy@example.com', 'Grace');
    const copied = await request(app)
      .post(`/api/public/templates/${templateId}/copy`)
      .set(bearer(grace.token))
      .send({ name: 'Our Lisbon', startDate: '2031-01-01' });
    expect(copied.status).toBe(201);
    expect(copied.body.plan.basedOnTitle).toBe('3 days in Lisbon');
    expect(copied.body.plan.basedOnCreator).toBe('Ada Lovelace');
    expect(copied.body.plan.basedOnTemplateId).toBe(templateId);
    const copiedFlight = await Event.findOne({
      planId: copied.body.plan._id,
      name: 'DL 961',
    }).lean();
    expect(copiedFlight.startTime.toISOString()).toBe('2031-01-01T10:00:00.000Z');
    expect(copiedFlight.bookingReference || '').toBe('');
    const sourceFlight = await Event.findOne({ planId, name: 'DL 961' }).lean();
    expect(sourceFlight.startTime.toISOString()).toBe('2030-06-02T10:00:00.000Z');
    expect(sourceFlight.bookingReference).toBe('ABC123');

    const edited = await request(app)
      .patch(`/api/published-templates/${templateId}`)
      .set(bearer(ada.token))
      .send(publishBody('Lisbon lights'));
    expect(edited.status).toBe(200);
    const copiedPlan = await Plan.findById(copied.body.plan._id).lean();
    expect(copiedPlan.basedOnTitle).toBe('3 days in Lisbon');
    expect(copiedFlight.startTime.toISOString()).toBe('2031-01-01T10:00:00.000Z');

    const again = await request(app)
      .post(`/api/published-templates/from/${planId}`)
      .set(bearer(ada.token))
      .send(publishBody('Lisbon lights'));
    expect(again.status).toBe(200);
    expect(again.body.template.id).toBe(templateId);

    const hidden = await request(app)
      .post(`/api/published-templates/${templateId}/unpublish`)
      .set(bearer(ada.token));
    expect(hidden.status).toBe(200);
    const gone = await request(app).get(`/api/public/templates/${templateId}`);
    expect(gone.status).toBe(404);
    const still = await Plan.findById(copied.body.plan._id).lean();
    expect(still.name).toBe('Our Lisbon');
    const stillFlight = await Event.findOne({
      planId: copied.body.plan._id,
      name: 'DL 961',
    }).lean();
    expect(stillFlight.startTime.toISOString()).toBe('2031-01-01T10:00:00.000Z');
  });

  test('plus and pro can publish, and a free owner or collaborator cannot', async () => {
    const ada = await registerAndLogin('ada-gate@example.com', 'Ada');
    const planId = await createPlan(ada.token, 'Locked');
    const denied = await request(app)
      .post(`/api/published-templates/from/${planId}`)
      .set(bearer(ada.token))
      .send(publishBody('Locked trip'));
    expect(denied.status).toBe(402);
    expect(denied.body.message).toBe('Upgrade to Plus to publish a template.');

    const grace = await registerAndLogin('grace-collab@example.com', 'Grace');
    await setTier(ada.userId, 'plus');
    const invite = await request(app)
      .post(`/api/plans/${planId}/invite`)
      .set(bearer(ada.token))
      .send({ email: 'grace-collab@example.com', role: 'Collaborator' });
    expect(invite.status).toBe(201);
    const accepted = await request(app)
      .post(`/api/invites/invitations/${invite.body.invitation._id}/respond`)
      .set(bearer(grace.token))
      .send({ status: 'accepted' });
    expect(accepted.status).toBe(200);
    const collab = await request(app)
      .post(`/api/published-templates/from/${planId}/preview`)
      .set(bearer(grace.token))
      .send(publishBody('Locked trip'));
    expect(collab.status).toBe(403);
    expect(collab.body.message).toBe('Only the Owner can publish a template.');

    const pro = await registerAndLogin('ada-pro@example.com', 'Ada');
    await setTier(pro.userId, 'pro');
    const proPlan = await createPlan(pro.token, 'Pro trip');
    const allowed = await request(app)
      .post(`/api/published-templates/from/${proPlan}`)
      .set(bearer(pro.token))
      .send(publishBody('Pro days'));
    expect(allowed.status).toBe(201);

    const anon = await request(app).get('/api/public/templates');
    expect(anon.status).toBe(200);
    const noToken = await request(app)
      .post(`/api/public/templates/${allowed.body.template.id}/copy`)
      .send({ name: 'Copy', startDate: '2031-01-01' });
    expect(noToken.status).toBe(401);
  });

  test('spam is refused and a sixth template in one day is refused', async () => {
    const ada = await registerAndLogin('ada-spam@example.com', 'Ada');
    await setTier(ada.userId, 'plus');
    const spamPlan = await createPlan(ada.token, 'Spam');
    const spam = await request(app)
      .post(`/api/published-templates/from/${spamPlan}`)
      .set(bearer(ada.token))
      .send({ ...publishBody('Free money weekend'), city: 'Lisbon' });
    expect(spam.status).toBe(400);
    expect(spam.body.message).toBe("This template can't be published.");
    expect(await PublishedTemplate.countDocuments({ ownerId: ada.userId })).toBe(0);

    for (let index = 0; index < 5; index += 1) {
      const planId = await createPlan(ada.token, `Day ${index}`);
      const made = await request(app)
        .post(`/api/published-templates/from/${planId}`)
        .set(bearer(ada.token))
        .send(publishBody(`Walk ${index}`));
      expect(made.status).toBe(201);
    }
    const extra = await createPlan(ada.token, 'One more');
    const blocked = await request(app)
      .post(`/api/published-templates/from/${extra}`)
      .set(bearer(ada.token))
      .send(publishBody('Walk again'));
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toBe('You can publish 5 templates a day.');
  });

  test('browse filters by city and a report is stored', async () => {
    const ada = await registerAndLogin('ada-browse@example.com', 'Ada');
    await setTier(ada.userId, 'plus');
    const lisbon = await createPlan(ada.token, 'Lisbon');
    const porto = await createPlan(ada.token, 'Porto');
    const first = await request(app)
      .post(`/api/published-templates/from/${lisbon}`)
      .set(bearer(ada.token))
      .send(publishBody('3 days in Lisbon'));
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/published-templates/from/${porto}`)
      .set(bearer(ada.token))
      .send({ ...publishBody('2 days in Porto'), city: 'Porto', title: '2 days in Porto' });
    expect(second.status).toBe(201);

    const filtered = await request(app).get('/api/public/templates?city=Lisbon');
    expect(filtered.status).toBe(200);
    expect(filtered.body.templates.map((row) => row.title)).toEqual(['3 days in Lisbon']);

    const report = await request(app)
      .post(`/api/public/templates/${first.body.template.id}/report`)
      .send({ reason: 'This is not a real trip' });
    expect(report.status).toBe(201);
    const storedReport = await TemplateReport.findOne({ templateId: first.body.template.id }).lean();
    expect(storedReport.reason).toBe('This is not a real trip');
    expect(storedReport.reporter).toBe('Not signed in');
    const mailed = sendEmail.mock.calls.map((call) => call[0]).find((message) => (
      message.subject === 'PlanItVibe template report'
    ));
    expect(mailed.to).toBe('ken@eratespecialists.com');
    expect(mailed.text).toContain(`https://planitvibe.com/template.html?id=${first.body.template.id}`);
    expect(mailed.text).toContain('This is not a real trip');
    expect(mailed.text).toContain('Not signed in');
    expect(mailed.text).toContain(`/api/admin/published-templates/${first.body.template.id}/unpublish`);
    const still = await PublishedTemplate.findById(first.body.template.id).lean();
    expect(still.published).toBe(true);

    sendEmail.mockRejectedValueOnce(new Error('mailbox down'));
    const again = await request(app)
      .post(`/api/public/templates/${first.body.template.id}/report`)
      .set(bearer(ada.token))
      .send({ reason: 'Still public' });
    expect(again.status).toBe(201);
    const named = await TemplateReport.findOne({ reason: 'Still public' }).lean();
    expect(named.reporter).toContain('ada-browse@example.com');
  });

  test('personal details in the title, description, or notes are stripped or blocked', async () => {
    const ada = await registerAndLogin('ada-private@example.com', 'Ada');
    await setTier(ada.userId, 'plus');
    await User.updateOne({ _id: ada.userId }, { $set: { firstName: '', lastName: '' } });
    const planId = await createPlan(ada.token, 'Private');
    const notes = [
      { name: 'Ride 404-555-0188', details: 'Ask for a window' },
      { name: 'Phone stop', details: 'Call 404-555-0199 tonight' },
      { name: 'Mail stop', details: 'Email ada@secret.test about the gate' },
      { name: 'Address stop', details: 'Home is 1842 Oak Lane' },
      { name: 'Booking stop', details: 'Booking ABC123 is in my bag' },
      { name: 'Confirm stop', details: 'Confirmation CONF999' },
      { name: 'Dinner', details: 'Ask for a window' },
    ];
    for (let index = 0; index < notes.length; index += 1) {
      const made = await request(app)
        .post('/api/activities')
        .set(bearer(ada.token))
        .send({
          type: 'activity',
          planId,
          name: notes[index].name,
          details: notes[index].details,
          startTime: `2030-06-02T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
          endTime: `2030-06-02T${String(11 + index).padStart(2, '0')}:00:00.000Z`,
        });
      expect(made.status).toBe(201);
    }

    const published = await request(app)
      .post(`/api/published-templates/from/${planId}`)
      .set(bearer(ada.token))
      .send(publishBody('3 days in Lisbon'));
    expect(published.status).toBe(201);
    expect(published.body.template.creatorName).toBe('A PlanItVibe member');
    const templateId = published.body.template.id;
    const page = await request(app).get(`/api/public/templates/${templateId}`);
    expect(page.status).toBe(200);
    const body = JSON.stringify(page.body);
    for (const secret of [
      '404-555-0188',
      '404-555-0199',
      'ada@secret.test',
      '1842 Oak Lane',
      'ABC123',
      'CONF999',
    ]) {
      expect(body).not.toContain(secret);
    }
    const dinner = page.body.template.stops.find((stop) => stop.name === 'Dinner');
    expect(dinner.details).toBe('Ask for a window');
    const ride = page.body.template.stops.find((stop) => stop.name === 'Ride');
    expect(ride.details).toBe('Ask for a window');

    const leaks = [
      { title: 'Call 404-555-0199', secret: '404-555-0199' },
      { description: 'Write ada@secret.test today', secret: 'ada@secret.test' },
      { title: 'Stay at 1842 Oak Lane', secret: '1842 Oak Lane' },
      { description: 'Confirmation CONF999', secret: 'CONF999' },
      { title: 'Booking ABC123', secret: 'ABC123' },
    ];
    for (const leak of leaks) {
      const fields = { ...publishBody('3 days in Lisbon'), ...leak };
      delete fields.secret;
      const preview = await request(app)
        .post(`/api/published-templates/from/${planId}/preview`)
        .set(bearer(ada.token))
        .send(fields);
      expect(preview.status).toBe(200);
      expect(preview.body.blocked).toBe("This template can't be published.");
      expect(JSON.stringify(preview.body)).not.toContain(leak.secret);
      const denied = await request(app)
        .post(`/api/published-templates/from/${planId}`)
        .set(bearer(ada.token))
        .send(fields);
      expect(denied.status).toBe(400);
      expect(denied.body.message).toBe("This template can't be published.");
    }
    const stored = await PublishedTemplate.findById(templateId).lean();
    expect(stored.title).toBe('3 days in Lisbon');
    expect(JSON.stringify(stored.activities)).not.toContain('ada@secret.test');
    expect(await PublishedTemplate.countDocuments({ ownerId: ada.userId })).toBe(1);
  });

  test('a reviewer can unpublish a reported template, and the daily check lists it once', async () => {
    const ada = await registerAndLogin('ada-report@example.com', 'Ada');
    await setTier(ada.userId, 'plus');
    const planId = await createPlan(ada.token, 'Reported');
    const published = await request(app)
      .post(`/api/published-templates/from/${planId}`)
      .set(bearer(ada.token))
      .send(publishBody('Reported days'));
    expect(published.status).toBe(201);
    const templateId = published.body.template.id;
    const member = await request(app)
      .post(`/api/admin/published-templates/${templateId}/unpublish`)
      .set(bearer(ada.token));
    expect(member.status).toBe(403);

    const report = await request(app)
      .post(`/api/public/templates/${templateId}/report`)
      .send({ reason: 'Please take this down' });
    expect(report.status).toBe(201);
    const when = new Date('2031-04-02T15:00:00.000Z');
    await TemplateReport.updateOne(
      { templateId },
      { $set: { createdAt: when } },
    );
    const first = await sendOpenReportDigest(when);
    expect(first.sent).toBe(true);
    const digest = sendEmail.mock.calls.map((call) => call[0]).find((message) => (
      message.subject === 'PlanItVibe template report check'
    ));
    expect(digest.to).toBe('ken@eratespecialists.com');
    expect(digest.text).toContain(`https://planitvibe.com/template.html?id=${templateId}`);
    expect(digest.text).toContain('Please take this down');
    expect(digest.text).toContain('Not signed in');
    const second = await sendOpenReportDigest(when);
    expect(second.sent).toBe(false);

    const reviewer = await registerAndLogin('ken-review@example.com', 'Ken');
    await User.updateOne({ _id: reviewer.userId }, { $set: { role: 'admin' } });
    const hidden = await request(app)
      .post(`/api/admin/published-templates/${templateId}/unpublish`)
      .set(bearer(reviewer.token));
    expect(hidden.status).toBe(200);
    expect(hidden.body.template.published).toBe(false);
    const gone = await request(app).get(`/api/public/templates/${templateId}`);
    expect(gone.status).toBe(404);
    const nextDay = new Date('2031-04-03T15:00:00.000Z');
    const quiet = await sendOpenReportDigest(nextDay);
    expect(quiet.sent).toBe(false);
    expect(quiet.open).toBe(0);
  });
});
