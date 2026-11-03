import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/ai_command_history.dart';

void main() {
  test('the sheet keeps the last 5 instructions and their summaries', () {
    var history = const <AiCommandTurn>[];
    for (var n = 1; n <= 6; n++) {
      history = appendAiCommandHistory(history, 'instruction $n', 'summary $n');
    }
    expect(history, hasLength(10));
    expect(history.first.content, 'instruction 2');
    expect(history.last.content, 'summary 6');
    expect(history.where((turn) => turn.role == 'user'), hasLength(5));
    expect(history.map((turn) => turn.toJson()).last, {
      'role': 'assistant',
      'content': 'summary 6',
    });
  });

  test('a blank summary is stored as no change', () {
    final history = appendAiCommandHistory(const [], 'make it later', '  ');
    expect(history, hasLength(2));
    expect(history[0].role, 'user');
    expect(history[0].content, 'make it later');
    expect(history[1].content, 'No change.');
  });

  test('a blank instruction does not add a turn', () {
    final kept = appendAiCommandHistory(
      const [AiCommandTurn(role: 'user', content: 'add dinner')],
      '   ',
      'Later dinner.',
    );
    expect(kept, hasLength(1));
    expect(kept.single.content, 'add dinner');
  });
}
