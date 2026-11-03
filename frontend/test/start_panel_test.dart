import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/activity_time.dart';

void main() {
  final july4At2pmEastern = instantFromWall(
    year: 2026,
    month: 7,
    day: 4,
    hour: 14,
    minute: 0,
    zone: 'America/New_York',
  );
  final july2At1130Eastern = instantFromWall(
    year: 2026,
    month: 7,
    day: 2,
    hour: 11,
    minute: 30,
    zone: 'America/New_York',
  );

  test('same day keeps the current time on the earlier day', () {
    final next = sameDayKeepingTime(
      above: july2At1130Eastern,
      current: july4At2pmEastern,
      zone: 'America/New_York',
    );
    expect(next, DateTime.utc(2026, 7, 2, 18));
    final clock = clockInZone(next!, 'America/New_York');
    expect(clock.hour, 14);
    expect(clock.minute, 0);
    expect(clock.day, 2);
  });

  test('same day uses the prior end time when the panel has no time', () {
    final next = sameDayKeepingTime(
      above: july2At1130Eastern,
      current: null,
      zone: 'America/New_York',
    );
    expect(next, july2At1130Eastern);
  });

  test('same day is unavailable when nothing is above', () {
    expect(
      sameDayKeepingTime(
        above: null,
        current: july4At2pmEastern,
        zone: 'America/New_York',
      ),
      isNull,
    );
  });

  test('chips add 30 minutes and one hour', () {
    expect(
      shiftByMinutes(july4At2pmEastern, 30),
      DateTime.utc(2026, 7, 4, 18, 30),
    );
    expect(
      shiftByMinutes(july4At2pmEastern, 60),
      DateTime.utc(2026, 7, 4, 19),
    );
  });

  test('next morning is 8:30 in the plan zone on the next calendar day', () {
    final summer = nextPlanMorning(july4At2pmEastern, 'America/New_York');
    expect(summer, DateTime.utc(2026, 7, 5, 12, 30));
    final summerClock = clockInZone(summer, 'America/New_York');
    expect(summerClock.hour, 8);
    expect(summerClock.minute, 30);
    expect(summerClock.day, 5);

    final winterCurrent = instantFromWall(
      year: 2026,
      month: 1,
      day: 15,
      hour: 15,
      minute: 0,
      zone: 'America/New_York',
    );
    final winter = nextPlanMorning(winterCurrent, 'America/New_York');
    expect(winter, DateTime.utc(2026, 1, 16, 13, 30));
  });

  test('next morning uses the plan zone when the clock zone differs', () {
    final chicago = instantFromWall(
      year: 2026,
      month: 7,
      day: 4,
      hour: 10,
      minute: 0,
      zone: 'America/Chicago',
    );
    final morning = nextPlanMorning(chicago, 'America/New_York');
    expect(morning, DateTime.utc(2026, 7, 5, 12, 30));
    final shown = clockInZone(morning, 'America/Chicago');
    expect(shown.hour, 7);
    expect(shown.minute, 30);
    expect(shown.day, 5);
  });
}
