import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/screens/plan_detail_screen.dart';

void main() {
  test('activity type choices are A to Z and car stays Drive', () {
    expect(activityTypeLabel('car'), 'Drive');
    final choices = activityTypeChoices('car');
    expect(
      [for (final type in choices) activityTypeLabel(type)],
      [
        'Activity',
        'Attraction',
        'Car Service',
        'Ceremony',
        'Cruise',
        'Custom',
        'Dining',
        'Drive',
        'Flight',
        'Hotel',
        'Reception',
        'Shuttle',
        'Tour',
        'Train',
      ],
    );
    expect(choices, contains('car'));
    expect(choices, isNot(contains('drive')));
  });

  test('an unknown stored type stays first and is not renamed', () {
    expect(activityTypeChoices('balloon').first, 'balloon');
    expect(activityTypeLabel('balloon'), 'balloon');
  });
}
