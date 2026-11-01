class PublishedStop {
  final String name;
  final String type;
  final int? day;
  final String start;
  final String end;
  final String details;

  const PublishedStop({
    required this.name,
    required this.type,
    required this.day,
    required this.start,
    required this.end,
    required this.details,
  });

  factory PublishedStop.fromJson(Map<String, dynamic> json) {
    final day = json['day'];
    return PublishedStop(
      name: (json['name'] ?? '').toString(),
      type: (json['type'] ?? '').toString(),
      day: day is num ? day.round() : null,
      start: (json['start'] ?? '').toString(),
      end: (json['end'] ?? '').toString(),
      details: (json['details'] ?? '').toString(),
    );
  }
}

class PublishedTemplateCard {
  final String id;
  final String title;
  final String description;
  final String city;
  final int tripLength;
  final String vibe;
  final String coverImage;
  final String creatorName;
  final int copyCount;
  final int viewCount;
  final bool published;
  final String sourcePlanId;
  final String sharePath;
  final List<PublishedStop> stops;

  const PublishedTemplateCard({
    required this.id,
    required this.title,
    this.description = '',
    this.city = '',
    this.tripLength = 1,
    this.vibe = '',
    this.coverImage = '',
    this.creatorName = '',
    this.copyCount = 0,
    this.viewCount = 0,
    this.published = true,
    this.sourcePlanId = '',
    this.sharePath = '',
    this.stops = const [],
  });

  factory PublishedTemplateCard.fromJson(Map<String, dynamic> json) {
    final id = json['id'] ?? json['_id'];
    final stops = json['stops'];
    return PublishedTemplateCard(
      id: id == null ? '' : id.toString(),
      title: (json['title'] ?? '').toString(),
      description: (json['description'] ?? '').toString(),
      city: (json['city'] ?? '').toString(),
      tripLength: json['tripLength'] is num ? (json['tripLength'] as num).round() : 1,
      vibe: (json['vibe'] ?? '').toString(),
      coverImage: (json['coverImage'] ?? '').toString(),
      creatorName: (json['creatorName'] ?? '').toString(),
      copyCount: json['copyCount'] is num ? (json['copyCount'] as num).round() : 0,
      viewCount: json['viewCount'] is num ? (json['viewCount'] as num).round() : 0,
      published: json['published'] != false,
      sourcePlanId: (json['sourcePlanId'] ?? '').toString(),
      sharePath: (json['sharePath'] ?? '').toString(),
      stops: stops is List
          ? [
              for (final stop in stops)
                if (stop is Map)
                  PublishedStop.fromJson(Map<String, dynamic>.from(stop)),
            ]
          : const [],
    );
  }
}

class PublishedPreview {
  final PublishedTemplateCard card;
  final List<String> removed;
  final String blocked;

  const PublishedPreview({
    required this.card,
    this.removed = const [],
    this.blocked = '',
  });
}

class LibraryResult {
  final int? status;
  final String? error;
  final String? nextTier;
  final String? nextTierName;
  final List<PublishedTemplateCard> templates;
  final PublishedTemplateCard? template;
  final PublishedPreview? preview;

  const LibraryResult({
    this.status,
    this.error,
    this.nextTier,
    this.nextTierName,
    this.templates = const [],
    this.template,
    this.preview,
  });
}
