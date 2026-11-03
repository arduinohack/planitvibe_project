import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/models/activity.dart';
import 'package:planitvibe_frontend/models/plan.dart';
import 'package:planitvibe_frontend/screens/plan_detail_screen.dart';

Activity _row({
  required String name,
  DateTime? start,
  bool linked = false,
}) {
  return Activity(
    id: name,
    planId: 'plan-1',
    name: name,
    startTime: start,
    linked: linked,
  );
}

void main() {
  test('a later stored row with an earlier start moves between its neighbors', () {
    final sorted = activitiesByUtcStart([
      _row(name: 'Noon', start: DateTime.utc(2026, 10, 25, 16, 6)),
      _row(name: 'Afternoon', start: DateTime.utc(2026, 10, 25, 17, 56)),
      _row(name: 'Visit', start: DateTime.utc(2026, 10, 25, 16, 26)),
    ]);

    expect(
      sorted.map((activity) => activity.name),
      ['Noon', 'Visit', 'Afternoon'],
    );
  });

  test('own and linked activities share one start-time list', () {
    final sorted = activitiesByUtcStart([
      _row(name: 'Own late', start: DateTime.utc(2026, 10, 25, 18)),
      _row(
        name: 'Linked early',
        start: DateTime.utc(2026, 10, 25, 15),
        linked: true,
      ),
      _row(name: 'Own middle', start: DateTime.utc(2026, 10, 25, 16)),
    ]);

    expect(
      sorted.map((activity) => activity.name),
      ['Linked early', 'Own middle', 'Own late'],
    );
    expect(sorted.first.linked, isTrue);
  });

  test('a missing start sorts after activities that have one', () {
    final sorted = activitiesByUtcStart([
      _row(name: 'No start'),
      _row(name: 'Later', start: DateTime.utc(2026, 10, 25, 18)),
      _row(name: 'Also missing'),
      _row(name: 'Earlier', start: DateTime.utc(2026, 10, 25, 12)),
    ]);

    expect(
      sorted.map((activity) => activity.name),
      ['Earlier', 'Later', 'No start', 'Also missing'],
    );
  });

  test('the same UTC instant keeps its order across local and UTC values', () {
    final utc = DateTime.utc(2026, 10, 25, 16, 26);
    final sorted = activitiesByUtcStart([
      _row(name: 'Local same', start: utc.toLocal()),
      _row(name: 'Utc same', start: utc),
      _row(name: 'Later', start: DateTime.utc(2026, 10, 25, 17, 56)),
    ]);

    expect(
      sorted.map((activity) => activity.name),
      ['Local same', 'Utc same', 'Later'],
    );
  });

  test('order follows the UTC instant when wall clocks are in different zones', () {
    // 01:00 in New York on Oct 26 is 05:00 UTC.
    // 22:00 in Honolulu on Oct 25 is 08:00 UTC the next day.
    final sorted = activitiesByUtcStart([
      _row(name: 'Hawaii evening', start: DateTime.utc(2026, 10, 26, 8)),
      _row(name: 'Eastern early', start: DateTime.utc(2026, 10, 26, 5)),
    ]);

    expect(
      sorted.map((activity) => activity.name),
      ['Eastern early', 'Hawaii evening'],
    );
  });

  test('day headers use the calendar day of the sorted start', () {
    final sorted = activitiesByUtcStart([
      _row(name: 'Next day', start: DateTime.utc(2026, 10, 26, 15)),
      _row(name: 'First day', start: DateTime.utc(2026, 10, 25, 16, 26)),
    ]);
    final headers = planItineraryDayHeaders(
      [for (final activity in sorted) activity.startTime],
      planTimeZone: 'UTC',
    );

    expect(headers, ['Day 1 · Sun 25-Oct', 'Day 2 · Mon 26-Oct']);
  });
}
