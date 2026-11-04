import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/activity_clock_sheet.dart';

void main() {
  final start = DateTime.utc(2026, 11, 4, 13, 24);

  test('opening rewrites the end from the start and the duration', () {
    final opened = openActivityTimes(
      start: start,
      end: start,
      durationMinutes: 71,
    );
    expect(opened.start, start);
    expect(opened.durationMinutes, 71);
    expect(opened.end, DateTime.utc(2026, 11, 4, 14, 35));
  });

  test('a missing duration leaves the clocks unchanged on open', () {
    final end = DateTime.utc(2026, 11, 4, 15);
    final opened = openActivityTimes(
      start: start,
      end: end,
      durationMinutes: null,
    );
    expect(opened.start, start);
    expect(opened.end, end);
    expect(opened.durationMinutes, isNull);
  });

  test('the last edited field recalculates the other two', () {
    final opened = openActivityTimes(start: start, durationMinutes: 71);

    final movedStart = recalculateActivityTimes(
      current: opened,
      edited: ActivityTimeEdit.start,
      start: start.add(const Duration(hours: 1)),
    );
    expect(movedStart.start, DateTime.utc(2026, 11, 4, 14, 24));
    expect(movedStart.durationMinutes, 71);
    expect(movedStart.end, DateTime.utc(2026, 11, 4, 15, 35));

    final movedEnd = recalculateActivityTimes(
      current: movedStart,
      edited: ActivityTimeEdit.end,
      end: DateTime.utc(2026, 11, 4, 16, 24),
    );
    expect(movedEnd.start, movedStart.start);
    expect(movedEnd.end, DateTime.utc(2026, 11, 4, 16, 24));
    expect(movedEnd.durationMinutes, 120);

    final movedDuration = recalculateActivityTimes(
      current: movedEnd,
      edited: ActivityTimeEdit.duration,
      durationMinutes: 30,
    );
    expect(movedDuration.start, movedEnd.start);
    expect(movedDuration.durationMinutes, 30);
    expect(movedDuration.end, DateTime.utc(2026, 11, 4, 14, 54));
  });

  test('editing the start keeps the gap when the duration field is empty', () {
    final current = ActivityTimeDraft(
      start: start,
      end: start.add(const Duration(minutes: 71)),
    );
    final next = recalculateActivityTimes(
      current: current,
      edited: ActivityTimeEdit.start,
      start: start.add(const Duration(hours: 1)),
    );
    expect(next.start, DateTime.utc(2026, 11, 4, 14, 24));
    expect(next.durationMinutes, isNull);
    expect(next.end, DateTime.utc(2026, 11, 4, 15, 35));
  });

  test('editing the end keeps the start when the end is earlier', () {
    final current = ActivityTimeDraft(
      start: start,
      end: start.add(const Duration(hours: 1)),
      durationMinutes: 60,
    );
    final next = recalculateActivityTimes(
      current: current,
      edited: ActivityTimeEdit.end,
      end: start.subtract(const Duration(minutes: 15)),
    );
    expect(next.start, start);
    expect(next.durationMinutes, -15);
  });

  test('zone fallback uses the place, then the prior end, then the plan', () {
    final withPlace = resolveActivityZones(
      placeZone: 'Europe/Paris',
      priorEndZone: 'America/Chicago',
      planZone: 'America/New_York',
    );
    expect(withPlace.startZone, 'America/Chicago');
    expect(withPlace.endZone, 'Europe/Paris');

    final priorOnly = resolveActivityZones(
      priorEndZone: 'America/Chicago',
      planZone: 'America/New_York',
    );
    expect(priorOnly.startZone, 'America/Chicago');
    expect(priorOnly.endZone, 'America/Chicago');

    final planOnly = resolveActivityZones(planZone: 'America/New_York');
    expect(planOnly.startZone, 'America/New_York');
    expect(planOnly.endZone, 'America/New_York');

    final placeWithoutPrior = resolveActivityZones(
      placeZone: 'Europe/Paris',
      planZone: 'America/New_York',
    );
    expect(placeWithoutPrior.startZone, 'America/New_York');
    expect(placeWithoutPrior.endZone, 'Europe/Paris');
  });

  test('an explicit zone pick is kept', () {
    final picked = resolveActivityZones(
      placeZone: 'Europe/Paris',
      priorEndZone: 'America/Chicago',
      planZone: 'America/New_York',
      explicitStartZone: 'Asia/Tokyo',
      explicitEndZone: 'Pacific/Honolulu',
    );
    expect(picked.startZone, 'Asia/Tokyo');
    expect(picked.endZone, 'Pacific/Honolulu');
  });

  test('blank zones are skipped and an empty plan zone is UTC', () {
    final blank = resolveActivityZones(
      placeZone: '  ',
      priorEndZone: '',
      planZone: '   ',
    );
    expect(blank.startZone, 'UTC');
    expect(blank.endZone, 'UTC');
  });
}
