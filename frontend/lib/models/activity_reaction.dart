class ActivityReactions {
  static const types = ['up', 'down', 'yes', 'no', 'maybe'];

  final Map<String, int> counts;
  final List<String> myVotes;

  const ActivityReactions({
    this.counts = const {},
    this.myVotes = const [],
  });

  static const empty = ActivityReactions();

  int count(String type) => counts[type] ?? 0;

  bool mine(String type) => myVotes.contains(type);

  /// Replaces the counts for one activity. Highlight changes only for [actorId]
  /// when that person is the signed-in user. A thumb replaces the other thumb.
  /// Yes, no, and maybe replace each other.
  ActivityReactions applyLive({
    required Map<String, int> counts,
    required String type,
    String actorId = '',
    String? currentUserId,
    bool? voted,
  }) {
    final nextCounts = <String, int>{
      for (final name in types) name: counts[name] ?? 0,
    };
    final self = (currentUserId ?? '').trim();
    final actor = actorId.trim();
    final updateMine =
        self.isNotEmpty && actor == self && types.contains(type) && voted != null;
    if (!updateMine) {
      return ActivityReactions(counts: nextCounts, myVotes: List<String>.from(myVotes));
    }
    final group = type == 'up' || type == 'down'
        ? const ['up', 'down']
        : const ['yes', 'no', 'maybe'];
    final nextVotes = <String>[];
    for (final vote in myVotes) {
      if (voted == false && vote == type) continue;
      if (voted == true && group.contains(vote)) continue;
      nextVotes.add(vote);
    }
    if (voted == true && !nextVotes.contains(type)) nextVotes.add(type);
    return ActivityReactions(counts: nextCounts, myVotes: nextVotes);
  }

  factory ActivityReactions.fromJson(Map<String, dynamic> json) {
    final raw = json['counts'];
    final counts = <String, int>{};
    if (raw is Map) {
      for (final type in types) {
        final value = raw[type];
        counts[type] = value is num ? value.round() : 0;
      }
    }
    final votes = <String>[];
    final mine = json['myVotes'];
    if (mine is List) {
      for (final item in mine) {
        final type = item == null ? '' : item.toString();
        if (types.contains(type) && !votes.contains(type)) votes.add(type);
      }
    }
    return ActivityReactions(counts: counts, myVotes: votes);
  }
}

class ActivityReactionResult {
  final int? status;
  final String? error;

  const ActivityReactionResult({this.status, this.error});
}
