const generateUserLoad = (userType, runtimeConfig) => {
  const patterns = runtimeConfig.userPatterns || {
    light: { cpu: 0.1, memory: 0.7 },
    medium: { cpu: 0.5, memory: 1.0 },
    heavy: { cpu: 0.8, memory: 1.5 }
  };
  return patterns[userType] || patterns.medium;
};

class UserSession {
  constructor(id, type) {
    this.id = id;
    this.type = type;
    this.startTime = new Date();
    this.lastActivity = new Date();
  }
}

// Helper function to convert memory string to MB
function parseMemory(memoryStr) {
  const value = parseInt(memoryStr);
  if (memoryStr.endsWith('Gi')) {
    return value * 1024; // Convert Gi to Mi
  }
  if (memoryStr.endsWith('Mi')) {
    return value;
  }
  return value;
}

// Helper function to convert CPU string to millicores
function parseCPU(cpuStr) {
  const value = parseInt(cpuStr);
  if (cpuStr.endsWith('m')) {
    return value;
  }
  return value * 1000; // Convert cores to millicores
}

function calculateResourcesForUsers(users, config) {
  if (!users || !config || !config.userResources) {
    return { cpu: 0, memory: 0 };
  }

  return users.reduce((total, user) => {
    const userLoad = generateUserLoad(user.type, config);
    // Convert percentage to actual millicores and MB
    const cpuUsage = (config.userResources.cpu / 100) * 1000; // Convert % to millicores
    const memoryUsage = (config.userResources.memory / 100) * 1024; // Convert % to MB

    return {
      cpu: total.cpu + (cpuUsage * userLoad.cpu),
      memory: total.memory + (memoryUsage * userLoad.memory)
    };
  }, { cpu: 0, memory: 0 });
}

function simulatePodUsage(pod, users, config) {
  if (!pod || !users || !config || !config.userResources) {
    return {
      cpu: 0,
      memory: 0,
      podName: pod?.name || 'unknown',
      timestamp: new Date().toISOString(),
      activeUsers: 0
    };
  }

  const podUsers = users.filter(u => u.podName === pod.name);
  const userResources = calculateResourcesForUsers(podUsers, config);
  
  // Convert pod limits to actual values
  const podLimits = {
    cpu: parseCPU(pod.resources.limits.cpu),    // Will be in millicores
    memory: parseMemory(pod.resources.limits.memory)  // Will be in MB
  };

  // Calculate percentages based on actual resource usage vs limits
  const cpuPercentage = (userResources.cpu / podLimits.cpu) * 100;
  const memoryPercentage = (userResources.memory / podLimits.memory) * 100;

  console.log(`Pod ${pod.name} metrics:`, {
    users: podUsers.length,
    userResources,
    podLimits,
    cpuPercentage,
    memoryPercentage
  });

  return {
    cpu: Math.min(100, Math.max(0, cpuPercentage)),
    memory: Math.min(100, Math.max(0, memoryPercentage)),
    podName: pod.name,
    timestamp: new Date().toISOString(),
    activeUsers: podUsers.length,
    rawMetrics: {
      cpu: userResources.cpu,
      memory: userResources.memory,
      cpuLimit: podLimits.cpu,
      memoryLimit: podLimits.memory
    }
  };
}

function calculateAverageUsage(podsMetrics) {
  if (!podsMetrics.length) return { cpu: 0, memory: 0, totalUsers: 0 };
  
  const totals = podsMetrics.reduce((acc, metric) => ({
    cpu: acc.cpu + metric.cpu,
    memory: acc.memory + metric.memory,
    totalUsers: acc.totalUsers + metric.activeUsers
  }), { cpu: 0, memory: 0, totalUsers: 0 });

  return {
    cpu: totals.cpu / podsMetrics.length,
    memory: totals.memory / podsMetrics.length,
    totalUsers: totals.totalUsers
  };
}

function distributeUsers(users, pods) {
  // If no pods are available, return users without assignment
  if (!pods || pods.length === 0) {
    users.forEach(user => delete user.podName);
    return users;
  }

  // Reset pod assignments
  users.forEach(user => delete user.podName);
  
  // Sort pods by current load
  const sortedPods = [...pods].sort((a, b) => 
    (a.metrics?.cpu || 0) - (b.metrics?.cpu || 0)
  );

  // Calculate max users per pod based on current metrics
  const maxUsersPerPod = Math.floor(users.length / pods.length) + 1;

  // Distribute users evenly with a maximum per pod
  users.forEach((user, index) => {
    const podIndex = Math.floor(index / maxUsersPerPod);
    if (podIndex < sortedPods.length) {
      user.podName = sortedPods[podIndex].name;
    }
  });

  return users;
}

function scaleReplicas(currentReplicas, avgCpu, avgMemory, totalUsers, config) {
  const cpuThreshold = config.cpuThreshold;
  const memoryThreshold = config.memoryThreshold;
  const podResources = config.podResources;
  
  // Calculate desired replicas based on resource usage
  const cpuDesiredReplicas = Math.ceil(currentReplicas * (avgCpu / cpuThreshold));
  const memoryDesiredReplicas = Math.ceil(currentReplicas * (avgMemory / memoryThreshold));
  
  // Take the maximum of all calculations
  const desiredReplicas = Math.max(
    cpuDesiredReplicas,
    memoryDesiredReplicas
  );

  return Math.min(
    Math.max(desiredReplicas, config.minReplicas),
    config.maxReplicas
  );
}

const generateLoad = (pattern, time, runtimeConfig) => {
  const {
    baseLoad,
    amplitude,
    period,
    spikeProbability = 0.1,
    spikeMultiplier = 2.0,
    maxUsers,
    userGrowthRate,
    initialUsers = baseLoad
  } = runtimeConfig.defaultLoadProfile;

  let load = baseLoad;
  
  switch (pattern) {
    case 'linear':
      // Calculate linear growth from initialUsers to maxUsers
      const timeInMinutes = (time % (24 * 3600)) / 60; // Reset every 24 hours
      load = initialUsers + (userGrowthRate * timeInMinutes);
      
      // Once reached maxUsers, stay there
      if (load >= maxUsers) {
        load = maxUsers;
      }
      break;
    case 'sine':
      load = baseLoad + amplitude * Math.sin((2 * Math.PI * time) / period);
      break;
    case 'spike':
      load = baseLoad + (time % period < period / 10 ? amplitude : 0);
      break;
    case 'sawtooth':
      load = baseLoad + amplitude * ((time % period) / period);
      break;
    case 'square':
      load = baseLoad + (Math.floor(time / (period / 2)) % 2 === 0 ? amplitude : 0);
      break;
    case 'random':
      const hasSpike = Math.random() < spikeProbability;
      const baseValue = baseLoad + (Math.random() - 0.5) * amplitude;
      load = hasSpike ? baseValue * spikeMultiplier : baseValue;
      break;
    case 'daily':
      const hourOfDay = (time % (24 * 3600)) / 3600;
      const workdayPattern = Math.sin((2 * Math.PI * (hourOfDay - 6)) / 24);
      const workdayMultiplier = hourOfDay >= 8 && hourOfDay <= 18 ? 1 : 0.3;
      load = baseLoad + amplitude * workdayPattern * workdayMultiplier;
      break;
    default:
      load = baseLoad;
  }

  // Ensure load never goes below initialUsers for linear pattern
  if (pattern === 'linear') {
    load = Math.max(initialUsers, Math.min(load, maxUsers));
  } else {
    // For other patterns, ensure load stays within bounds
    load = Math.max(0, Math.min(load, maxUsers));
  }

  return Math.floor(load);
};

let simulationStartTime = null;

function simulateUserActivity(runtimeConfig) {
  const currentTime = Date.now() / 1000; // Current time in seconds
  
  // Initialize start time if not set
  if (!simulationStartTime) {
    simulationStartTime = currentTime;
  }
  
  // For linear pattern, calculate users based on elapsed time since simulation start
  if (runtimeConfig.defaultLoadProfile.pattern === 'linear') {
    const {
      baseLoad,
      maxUsers,
      userGrowthRate
    } = runtimeConfig.defaultLoadProfile;

    // Calculate elapsed minutes since simulation start
    const elapsedMinutes = (currentTime - simulationStartTime) / 60;
    
    // Calculate target users: baseLoad + (growthRate * minutes)
    const targetUsers = Math.min(
      maxUsers,
      Math.floor(baseLoad + (userGrowthRate * elapsedMinutes))
    );

    console.log('Linear Pattern:', {
      elapsedMinutes,
      baseLoad,
      targetUsers,
      maxUsers,
      userGrowthRate,
      currentUsers: users.length
    });

    // Adjust user count
    while (users.length < targetUsers) {
      const userTypes = ['light', 'medium', 'heavy'];
      const randomType = userTypes[Math.floor(Math.random() * userTypes.length)];
      users.push(new UserSession(`user-${users.length + 1}`, randomType));
    }

    while (users.length > targetUsers) {
      users.pop();
    }

    return users;
  } else {
    // Reset simulation start time for other patterns
    simulationStartTime = null;
    
    // For other patterns, use the generateLoad function
    const targetUsers = Math.floor(generateLoad(
      runtimeConfig.defaultLoadProfile.pattern,
      currentTime,
      runtimeConfig
    ));

    // Adjust user count
    while (users.length < targetUsers) {
      const userTypes = ['light', 'medium', 'heavy'];
      const randomType = userTypes[Math.floor(Math.random() * userTypes.length)];
      users.push(new UserSession(`user-${users.length + 1}`, randomType));
    }

    while (users.length > targetUsers) {
      users.pop();
    }

    return users;
  }
}

// Add function to reset simulation
function resetSimulation() {
  simulationStartTime = null;
  users = [];
}

module.exports = {
  generateUserLoad,
  UserSession,
  simulatePodUsage,
  calculateAverageUsage,
  distributeUsers,
  scaleReplicas,
  parseMemory,
  parseCPU,
  generateLoad,
  simulateUserActivity,
  resetSimulation
};
  