import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'login_screen.dart'; // Navigate on logout
// Navigate to signup
import '../models/plan.dart';
import '../models/plan_role_label.dart';
import '../utils/plus_upgrade.dart';
import '../utils/verify_email.dart';
import '../providers/plan_provider.dart';
import '../providers/user_provider.dart'; // For role and logout
import 'ai_settings_screen.dart';
import 'coordinator_dashboard_screen.dart'; // For coordinators
import 'invitations_screen.dart';
import 'plan_detail_screen.dart';
import 'user_profile_screen.dart'; // For profile
import 'settings_screen.dart';
import 'library_screen.dart';
import 'templates_screen.dart';
import '../models/user.dart'; // For UserRole enum

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool _loaded = false;
  bool _resending = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadPlans());
  }

  Future<void> _loadPlans() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final status = await planProvider.fetchPlans(userProvider.token);
    if (!mounted) return;
    if (status != 401) {
      await userProvider.loadPlanAccess();
      if (!mounted) return;
    }
    int? roleStatus;
    if (status == 200) {
      roleStatus = await planProvider.loadViewerRoles(
        userProvider.token,
        userProvider.currentUserId,
      );
      if (!mounted) return;
    }
    setState(() => _loaded = true);
    if (status == 401 || roleStatus == 401) {
      await _endSession(userProvider, planProvider, navigator);
    }
  }

  Future<void> _endSession(
    UserProvider userProvider,
    PlanProvider planProvider,
    NavigatorState navigator,
  ) async {
    planProvider.clearPlans();
    await userProvider.logout();
    if (!mounted) return;
    navigator.pushAndRemoveUntil(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
      (route) => false,
    );
  }

  Future<void> _resendVerification() async {
    if (_resending) return;
    setState(() => _resending = true);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final note = await userProvider.resendVerification();
    if (!mounted) return;
    setState(() => _resending = false);
    messenger.showSnackBar(SnackBar(content: Text(note)));
  }

  Future<void> _logOut() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    await _endSession(userProvider, planProvider, navigator);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('PlanItVibe'), // App title
        actions: [
          IconButton(
            icon: const Icon(Icons.public),
            tooltip: 'Library',
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => const LibraryScreen(),
                ),
              );
            },
          ),
          IconButton(
            icon: const Icon(Icons.bookmark_border),
            tooltip: 'Templates',
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => const TemplatesScreen(),
                ),
              );
            },
          ),
          IconButton(
            icon: const Icon(Icons.mail),
            tooltip: 'Invitations',
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => const InvitationsScreen(),
                ),
              );
            },
          ),
          if (Provider.of<UserProvider>(context).currentUserRole ==
              UserRole.vibeCoordinator)
            IconButton(
              icon: const Icon(Icons.dashboard),
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => const CoordinatorDashboardScreen(),
                  ),
                );
              },
              tooltip: 'Coordinator dashboard',
            ),
          IconButton(
            icon: const Icon(Icons.person),
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => const UserProfileScreen(),
                ),
              );
            },
            tooltip: 'Edit profile',
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (context) => const SettingsScreen()),
              );
            },
            tooltip: 'App Settings',
          ),
          IconButton(
            icon: const Icon(Icons.door_front_door),
            tooltip: 'Log out',
            onPressed: _logOut,
          ),
          PopupMenuButton<String>(
            tooltip: 'App menu',
            onSelected: (choice) {
              if (choice == 'ai-settings') {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => const AiSettingsScreen(),
                  ),
                );
                return;
              }
              if (choice != 'logout') return;
              _logOut();
            },
            itemBuilder: (context) => const [
              PopupMenuItem<String>(
                value: 'ai-settings',
                child: Text('AI settings'),
              ),
              PopupMenuItem<String>(value: 'logout', child: Text('Log out')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          Consumer<UserProvider>(
            builder: (context, userProvider, _) {
              if (!userProvider.needsEmailVerification) {
                return const SizedBox.shrink();
              }
              return Material(
                color: Theme.of(context).colorScheme.tertiaryContainer,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 8,
                  ),
                  child: Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'Check your email to verify your account',
                        ),
                      ),
                      TextButton(
                        onPressed: _resending ? null : _resendVerification,
                        child: const Text('Resend'),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
          Consumer<UserProvider>(
            builder: (context, userProvider, _) {
              final label = userProvider.planAccess?.trialEndsLabel;
              if (label == null) return const SizedBox.shrink();
              return Material(
                color: Theme.of(context).colorScheme.secondaryContainer,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 10,
                  ),
                  child: SizedBox(width: double.infinity, child: Text(label)),
                ),
              );
            },
          ),
          Expanded(
            child: Consumer<PlanProvider>(
              builder: (context, planProvider, child) {
                final waiting = !_loaded || planProvider.isLoading;
                if (waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (planProvider.plansError != null) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        planProvider.plansError!,
                        textAlign: TextAlign.center,
                      ),
                    ),
                  );
                }
                if (planProvider.plans.isEmpty) {
                  return const Center(
                    child: Text(
                      'No plans yet',
                      style: TextStyle(fontSize: 20),
                      textAlign: TextAlign.center,
                    ),
                  );
                }
                final active = [
                  for (final plan in planProvider.plans)
                    if (!plan.isArchived) plan,
                ];
                final archived = [
                  for (final plan in planProvider.plans)
                    if (plan.isArchived) plan,
                ];
                return ListView(
                  children: [
                    for (final plan in active) _activePlanCard(plan),
                    if (archived.isNotEmpty) ...[
                      const Padding(
                        padding: EdgeInsets.fromLTRB(16, 24, 16, 8),
                        child: Text(
                          'Archived',
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                      for (final plan in archived) _archivedPlanCard(plan),
                    ],
                  ],
                );
              },
            ),
          ),
        ],
      ),
      floatingActionButton: Consumer<UserProvider>(
        builder: (context, userProvider, child) {
          if (userProvider.currentUserRole == UserRole.vibeCoordinator) {
            return FloatingActionButton.extended(
              onPressed: () => _showCreatePlanDialog(context),
              icon: const Icon(Icons.add),
              label: const Text('New Plan'),
              backgroundColor: Colors.green,
            );
          }
          return const SizedBox.shrink();
        },
      ),
    );
  }

  Widget _activePlanCard(Plan plan) {
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final userId = Provider.of<UserProvider>(context, listen: false).currentUserId;
    final storedRole = planProvider.viewerStoredRole(plan.id, userId);
    final roleText = storedRole == null
        ? null
        : planRoleLabel(plan.type, storedRole);
    final dateLine = planSpanDateLine(
      earliestStart: plan.earliestStart,
      latestEnd: plan.latestEnd,
      planTimeZone: plan.timeZone,
    );
    final owner = storedRole?.trim() == 'Owner';
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            title: Text(plan.name),
            subtitle: Text(
              [
                'Type: ${plan.type}',
                if (roleText != null) 'Role: $roleText',
                'Destination: ${plan.destination}',
                'Budget: ${formatPlanBudget(plan.budget)}',
                if (dateLine != null) dateLine,
              ].join('\n'),
            ),
            onTap: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => PlanDetailScreen(plan: plan),
                ),
              );
            },
          ),
          if (owner)
            Align(
              alignment: Alignment.centerLeft,
              child: Wrap(
                children: [
                  TextButton(
                    onPressed: () => _copyPlan(plan),
                    child: const Text('Copy'),
                  ),
                  TextButton(
                    onPressed: () => _saveAsTemplate(plan),
                    child: const Text('Save as template'),
                  ),
                  TextButton(
                    onPressed: () => _archivePlan(plan),
                    child: const Text('Archive'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _archivedPlanCard(Plan plan) {
    final archivedOn = plan.archivedAt == null
        ? null
        : 'Archived: ${formatPlanDate(plan.archivedAt)}';
    final lines = [
      if (plan.archiveDescription.trim().isNotEmpty)
        plan.archiveDescription.trim(),
      if (archivedOn != null) archivedOn,
    ];
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            title: Text(plan.name),
            subtitle: lines.isEmpty ? null : Text(lines.join('\n')),
            onTap: _showArchivedPlan,
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => _recallPlan(plan),
              child: const Text('Recall'),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _showArchivedPlan() {
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        content: const Text(archivedPlanMessage),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  Future<void> _recallPlan(Plan plan) async {
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final status = await planProvider.recallPlan(
      planId: plan.id,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status == 200) {
      await planProvider.fetchPlans(userProvider.token);
      if (!mounted) return;
      await userProvider.loadPlanAccess();
      return;
    }
    if (status == 402) {
      if (!context.mounted) return;
      await showPlusUpgradeDialog(
        context,
        message: planProvider.writeMessage ?? 'Upgrade to own more plans.',
        token: userProvider.token,
        pack: planProvider.upgradePack ?? 'plus_monthly',
        tierName: planProvider.upgradeTierName,
        showUpgrade: planProvider.upgradePack != null,
      );
      return;
    }
    messenger.showSnackBar(
      SnackBar(
        content: Text(planProvider.writeMessage ?? 'Could not recall this plan'),
      ),
    );
  }

  Future<void> _archivePlan(Plan plan) async {
    final descriptionController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Archive ${plan.name}?'),
        content: TextField(
          controller: descriptionController,
          maxLength: 500,
          maxLines: 3,
          decoration: const InputDecoration(labelText: 'Description'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Archive'),
          ),
        ],
      ),
    );
    final description = descriptionController.text.trim();
    descriptionController.dispose();
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final status = await planProvider.archivePlan(
      planId: plan.id,
      description: description,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status == 200) {
      await userProvider.loadPlanAccess();
      return;
    }
    messenger.showSnackBar(
      SnackBar(
        content: Text(planProvider.writeMessage ?? 'Could not archive this plan'),
      ),
    );
  }

  Future<void> _copyPlan(Plan plan) async {
    final nameController = TextEditingController(text: 'Copy of ${plan.name}');
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Copy plan'),
        content: TextField(
          controller: nameController,
          decoration: const InputDecoration(labelText: 'Name'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Copy'),
          ),
        ],
      ),
    );
    final name = nameController.text.trim();
    nameController.dispose();
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.copyPlan(
      planId: plan.id,
      name: name,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to own more plans.',
        token: userProvider.token,
        pack: planProvider.upgradePack ?? 'plus_monthly',
        tierName: planProvider.upgradeTierName,
        showUpgrade: planProvider.upgradePack != null,
      );
      return;
    }
    final created = result.plan;
    if (result.status != 201 || created == null) {
      messenger.showSnackBar(
        SnackBar(content: Text(result.error ?? 'Could not copy this plan')),
      );
      return;
    }
    await userProvider.loadPlanAccess();
    if (!mounted) return;
    await navigator.push(
      MaterialPageRoute(
        builder: (context) => PlanDetailScreen(plan: created),
      ),
    );
  }

  Future<void> _saveAsTemplate(Plan plan) async {
    final nameController = TextEditingController(text: plan.name);
    final descriptionController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Save as template'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameController,
                decoration: const InputDecoration(labelText: 'Name'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: descriptionController,
                decoration: const InputDecoration(labelText: 'Description'),
                maxLines: 3,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    final name = nameController.text.trim();
    final description = descriptionController.text.trim();
    nameController.dispose();
    descriptionController.dispose();
    if (confirmed != true || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    if (name.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('Name is required.')));
      return;
    }
    final status = await planProvider.saveAsTemplate(
      planId: plan.id,
      name: name,
      description: description,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (status == 201) {
      messenger.showSnackBar(const SnackBar(content: Text('Saved as template')));
      return;
    }
    messenger.showSnackBar(
      SnackBar(
        content: Text(planProvider.writeMessage ?? 'Could not save this template'),
      ),
    );
  }

  void _showCreatePlanDialog(BuildContext context) {
    final nameController = TextEditingController();
    final destinationController = TextEditingController();
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);

    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Create plan'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextFormField(
              controller: nameController,
              decoration: const InputDecoration(labelText: 'Plan name'),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: destinationController,
              decoration: const InputDecoration(labelText: 'Destination'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () async {
              final name = nameController.text.trim();
              final destination = destinationController.text.trim();
              if (name.isEmpty || destination.isEmpty) return;
              final status = await planProvider.createPlan(
                Plan(
                  id: '',
                  type: 'trip',
                  name: name,
                  destination: destination,
                  startDate: DateTime.now(),
                  endDate: DateTime.now().add(const Duration(days: 7)),
                  autoCalculateStartDate: false,
                  autoCalculateEndDate: false,
                  location: '',
                  budget: 0,
                  planningState: 'initial',
                  timeZone: 'UTC',
                  ownerId: userProvider.currentUserId ?? '',
                  createdAt: DateTime.now(),
                ),
                userProvider.token,
              );
              if (!mounted) return;
              if (status == 201) {
                await userProvider.loadPlanAccess();
                if (!mounted) return;
                navigator.pop();
                return;
              }
              if (status == 401) {
                navigator.pop();
                await _endSession(userProvider, planProvider, navigator);
                return;
              }
              if (status == 403) {
                navigator.pop();
                if (!context.mounted) return;
                await showVerifyEmailDialog(
                  context,
                  message:
                      planProvider.writeMessage ??
                      verifyEmailBeforePlanMessage,
                );
                return;
              }
              if (status == 402) {
                navigator.pop();
                if (!context.mounted) return;
                await showPlusUpgradeDialog(
                  context,
                  message:
                      planProvider.writeMessage ??
                      'Upgrade to own more plans.',
                  token: userProvider.token,
                  pack: planProvider.upgradePack ?? 'plus_monthly',
                  tierName: planProvider.upgradeTierName,
                  showUpgrade: planProvider.upgradePack != null,
                );
                return;
              }
              messenger.showSnackBar(
                SnackBar(
                  content: Text(
                    status == null
                        ? 'Could not create plan'
                        : 'Could not create plan ($status)',
                  ),
                ),
              );
            },
            child: const Text('Create'),
          ),
        ],
      ),
    );
  }
}
