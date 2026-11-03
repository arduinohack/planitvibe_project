import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/models/activity_attachment.dart';
import 'package:planitvibe_frontend/utils/activity_attachment.dart';

void main() {
  test('sizes use B, KB, and MB', () {
    expect(formatAttachmentSize(0), '0 B');
    expect(formatAttachmentSize(512), '512 B');
    expect(formatAttachmentSize(1536), '1.5 KB');
    expect(formatAttachmentSize(attachmentMaxBytes), '10 MB');
  });

  test('upload names drop a directory and stay non-empty', () {
    expect(attachmentUploadName(r'C:\photos\ticket.pdf'), 'ticket.pdf');
    expect(attachmentUploadName('folder/photo.jpg'), 'photo.jpg');
    expect(attachmentUploadName('   '), 'attachment');
  });

  test(
    'role rules: Guest views only, Owner deletes any, uploader deletes own',
    () {
      expect(canAddActivityAttachment('Owner'), isTrue);
      expect(canAddActivityAttachment('Collaborator'), isTrue);
      expect(canAddActivityAttachment('Guest'), isFalse);
      expect(canAddActivityAttachment(null), isFalse);

      expect(
        canDeleteActivityAttachment(
          storedRole: 'Owner',
          userId: 'owner',
          uploadedBy: 'someone',
        ),
        isTrue,
      );
      expect(
        canDeleteActivityAttachment(
          storedRole: 'Collaborator',
          userId: 'ada',
          uploadedBy: 'ada',
        ),
        isTrue,
      );
      expect(
        canDeleteActivityAttachment(
          storedRole: 'Collaborator',
          userId: 'ada',
          uploadedBy: 'gus',
        ),
        isFalse,
      );
      expect(
        canDeleteActivityAttachment(
          storedRole: 'Guest',
          userId: 'gus',
          uploadedBy: 'gus',
        ),
        isFalse,
      );
    },
  );

  test('limit, type, auth, and network errors keep a clear message', () {
    expect(attachmentErrorMessage(null, null), attachmentNetworkMessage);
    expect(attachmentErrorMessage(401, ''), 'Sign in again to continue.');
    expect(
      attachmentErrorMessage(401, 'Token is not valid'),
      'Token is not valid',
    );
    expect(
      attachmentErrorMessage(
        403,
        'Only Owner or Collaborator can add attachments',
      ),
      'Only Owner or Collaborator can add attachments',
    );
    expect(attachmentErrorMessage(413, null), attachmentSizeMessage);
    expect(attachmentErrorMessage(415, ''), attachmentTypeMessage);
    expect(
      attachmentErrorMessage(400, 'An activity can have at most 5 attachments'),
      'An activity can have at most 5 attachments',
    );
  });

  test('a public attachment parses and drops a missing id', () {
    final parsed = ActivityAttachment.tryParse({
      'id': 'file-1',
      'activityId': 'act-1',
      'planId': 'plan-1',
      'uploadedBy': 'ada',
      'filename': 'ticket.pdf',
      'mimeType': 'application/pdf',
      'size': 2048,
      'createdAt': '2026-10-27T12:00:00.000Z',
      'storageKey': 'aa/bb/secret',
    });
    expect(parsed?.id, 'file-1');
    expect(parsed?.filename, 'ticket.pdf');
    expect(parsed?.size, 2048);
    expect(parsed?.uploadedBy, 'ada');
    expect(ActivityAttachment.tryParse({'filename': 'x.png'}), isNull);
  });

  test('pdf and image detection follow the sniffed type', () {
    expect(attachmentIsPdf('application/pdf', 'ticket.txt'), isTrue);
    expect(attachmentIsPdf('text/plain', 'notes.pdf'), isTrue);
    expect(attachmentIsImage('image/jpeg', 'photo.bin'), isTrue);
    expect(attachmentIsImage('', 'scan.heic'), isTrue);
    expect(attachmentIsImage('application/pdf', 'ticket.pdf'), isFalse);
  });
}
