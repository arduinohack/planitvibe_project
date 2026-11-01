class PlanTemplate {
  final String id;
  final String name;
  final String description;
  final String sourcePlanId;
  final String destination;
  final DateTime? startDate;
  final DateTime? endDate;

  const PlanTemplate({
    required this.id,
    required this.name,
    this.description = '',
    this.sourcePlanId = '',
    this.destination = '',
    this.startDate,
    this.endDate,
  });

  /// Inclusive day count from the saved plan dates, clamped to the publish form.
  int get tripLengthDays {
    final start = startDate;
    final end = endDate;
    if (start == null || end == null) return 1;
    var days = end.toUtc().difference(start.toUtc()).inDays + 1;
    if (days < 1) return 1;
    if (days > 60) return 60;
    return days;
  }

  factory PlanTemplate.fromJson(Map<String, dynamic> json) {
    final id = json['_id'] ?? json['id'];
    return PlanTemplate(
      id: id == null ? '' : id.toString(),
      name: (json['name'] ?? '').toString(),
      description: (json['description'] ?? '').toString(),
      sourcePlanId: (json['sourcePlanId'] ?? '').toString(),
      destination: (json['destination'] ?? '').toString(),
      startDate: _date(json['startDate']),
      endDate: _date(json['endDate']),
    );
  }
}

DateTime? _date(Object? value) {
  if (value is! String || value.trim().isEmpty) return null;
  return DateTime.tryParse(value);
}
