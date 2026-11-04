/// Start, end, and duration for the activity sheet.
///
/// Instants are UTC. The sheet rewrites the other fields from whichever one
/// was edited last. Nothing here is saved.
class ActivityTimeDraft {
  final DateTime? start;
  final DateTime? end;
  final int? durationMinutes;

  const ActivityTimeDraft({
    this.start,
    this.end,
    this.durationMinutes,
  });
}

enum ActivityTimeEdit { start, end, duration }

DateTime? _utc(DateTime? instant) => instant?.toUtc();

/// On open, the end is start plus the duration minutes.
///
/// When the duration is missing, the clocks stay as they were.
ActivityTimeDraft openActivityTimes({
  required DateTime? start,
  required int? durationMinutes,
  DateTime? end,
}) {
  final startUtc = _utc(start);
  if (startUtc != null && durationMinutes != null) {
    return ActivityTimeDraft(
      start: startUtc,
      end: startUtc.add(Duration(minutes: durationMinutes)),
      durationMinutes: durationMinutes,
    );
  }
  return ActivityTimeDraft(
    start: startUtc,
    end: _utc(end),
    durationMinutes: durationMinutes,
  );
}

/// Last edited field drives the other two. The start stays put unless it
/// was the field that changed.
ActivityTimeDraft recalculateActivityTimes({
  required ActivityTimeDraft current,
  required ActivityTimeEdit edited,
  DateTime? start,
  DateTime? end,
  int? durationMinutes,
}) {
  switch (edited) {
    case ActivityTimeEdit.start:
      final nextStart = _utc(start ?? current.start);
      var minutes = current.durationMinutes;
      if (minutes == null &&
          current.start != null &&
          current.end != null &&
          !current.end!.isBefore(current.start!)) {
        minutes = current.end!
            .toUtc()
            .difference(current.start!.toUtc())
            .inMinutes;
      }
      if (nextStart != null && minutes != null) {
        return ActivityTimeDraft(
          start: nextStart,
          end: nextStart.add(Duration(minutes: minutes)),
          durationMinutes: current.durationMinutes,
        );
      }
      return ActivityTimeDraft(
        start: nextStart,
        end: _utc(current.end),
        durationMinutes: current.durationMinutes,
      );
    case ActivityTimeEdit.end:
      final kept = _utc(current.start);
      final nextEnd = _utc(end ?? current.end);
      int? minutes = current.durationMinutes;
      if (kept != null && nextEnd != null) {
        minutes = nextEnd.difference(kept).inMinutes;
      }
      return ActivityTimeDraft(
        start: kept,
        end: nextEnd,
        durationMinutes: minutes,
      );
    case ActivityTimeEdit.duration:
      final kept = _utc(current.start);
      final minutes = durationMinutes;
      if (kept != null && minutes != null) {
        return ActivityTimeDraft(
          start: kept,
          end: kept.add(Duration(minutes: minutes)),
          durationMinutes: minutes,
        );
      }
      return ActivityTimeDraft(
        start: kept,
        end: _utc(current.end),
        durationMinutes: minutes,
      );
  }
}

class ActivityZoneChoice {
  final String startZone;
  final String endZone;

  const ActivityZoneChoice({
    required this.startZone,
    required this.endZone,
  });
}

String _zoneOrEmpty(String? zone) => zone?.trim() ?? '';

/// Display zones. Stored instants stay UTC.
///
/// End zone: the selected place, then the prior activity's end zone, then
/// the plan zone. Start zone: the prior end zone, then the plan zone.
/// An explicit pick is kept and is not replaced by a later fallback.
ActivityZoneChoice resolveActivityZones({
  String? placeZone,
  String? priorEndZone,
  required String planZone,
  String? explicitStartZone,
  String? explicitEndZone,
}) {
  final plan = _zoneOrEmpty(planZone).isEmpty ? 'UTC' : planZone.trim();
  final prior = _zoneOrEmpty(priorEndZone);
  final place = _zoneOrEmpty(placeZone);
  final pickedStart = _zoneOrEmpty(explicitStartZone);
  final pickedEnd = _zoneOrEmpty(explicitEndZone);
  final start = pickedStart.isNotEmpty
      ? pickedStart
      : (prior.isNotEmpty ? prior : plan);
  final end = pickedEnd.isNotEmpty
      ? pickedEnd
      : (place.isNotEmpty ? place : (prior.isNotEmpty ? prior : plan));
  return ActivityZoneChoice(startZone: start, endZone: end);
}
