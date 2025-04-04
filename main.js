const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Notification } = require('electron');
const path = require('path');
const Store = require('electron-store');
const youtubedl = require('youtube-dl-exec');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');
const ytdlp = require('yt-dlp-exec');
const { spawn } = require('child_process');
const os = require('os');

// Initialize the local storage
const store = new Store({
  name: 'daily-progress-data',
  defaults: {
    'youtube-categories': ['Entertainment', 'Education', 'Music', 'Technology', 'Sports'],
    'youtube-links': [],
    'tasks': [],
    'reminders': [],
    'schedule': []
  }
});

// Create a global variable to hold the window reference
let mainWindow = null;

// Define platform-specific paths for yt-dlp
const getYtDlpPath = () => {
  try {
    // For Windows, search in several possible locations
    if (process.platform === 'win32') {
      const possiblePaths = [
        // Try the pip installed path first
        'C:\\Users\\mrcon\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\\LocalCache\\local-packages\\Python311\\Scripts\\yt-dlp.exe',
        // Look in PATH for yt-dlp
        path.join(process.env.APPDATA, 'Python', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
        // Default to just the command and hope it's in PATH
        'yt-dlp.exe'
      ];
      
      for (const pathToCheck of possiblePaths) {
        if (fs.existsSync(pathToCheck)) {
          console.log(`Found yt-dlp at: ${pathToCheck}`);
          return pathToCheck;
        }
      }
      // If not found in expected locations, default to command name
      return 'yt-dlp.exe';
    }
    
    // For macOS and Linux, just use the command name
    return 'yt-dlp';
  } catch (error) {
    console.error('Error determining yt-dlp path:', error);
    return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  }
};

// Initialize the yt-dlp path
const ytDlpPath = getYtDlpPath();
console.log(`Using yt-dlp path: ${ytDlpPath}`);

// Function to get YouTube video details
async function getVideoDetails(url) {
  try {
    // Extract video ID first
    const videoId = extractVideoIdFromUrl(url);
    
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }
    
    // Direct API call for title (most reliable)
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const response = await fetch(oembedUrl);
      
      if (response.ok) {
        const data = await response.json();
        console.log('Successfully fetched video title via oEmbed:', data.title);
        
        return {
          id: videoId,
          title: data.title,
          duration: 'Unknown duration',
          thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        };
      }
    } catch (oembedError) {
      console.warn('oEmbed API failed, trying youtube-dl-exec:', oembedError.message);
    }
    
    // Try youtube-dl-exec as backup
    try {
      const output = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        skipDownload: true
      });
      
      // Format duration from seconds to MM:SS
      let duration = 'Unknown';
      if (output.duration) {
        const minutes = Math.floor(output.duration / 60);
        const seconds = output.duration % 60;
        duration = `${minutes}:${seconds < 10 ? '0' + seconds : seconds}`;
      }
      
      return {
        id: output.id,
        title: output.title || 'YouTube Video',
        duration: duration,
        thumbnail: output.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      };
    } catch (ytdlError) {
      console.warn('youtube-dl-exec failed:', ytdlError.message);
      
      // Final fallback
      return {
        id: videoId,
        title: `YouTube Video (${videoId.substring(0, 6)}...)`,
        duration: 'Unknown duration',
        thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      };
    }
  } catch (error) {
    console.error('Error getting video details:', error);
    
    // Extract video ID from URL even if previous methods failed
    const videoId = extractVideoIdFromUrl(url) || createFallbackId(url);
    
    // Return a basic fallback with the video ID
    return {
      id: videoId,
      title: `YouTube Video`,
      duration: 'Unknown',
      thumbnail: videoId.length === 11 ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null,
    };
  }
}

// Helper function to extract video ID from YouTube URL
function extractVideoIdFromUrl(url) {
  try {
    // Handle YouTube Shorts URLs
    if (url.includes('youtube.com/shorts/')) {
      const shortsRegExp = /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/;
      const match = url.match(shortsRegExp);
      return match ? match[1] : null;
    }
    
    // Handle standard YouTube URLs
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[7] && match[7].length === 11) ? match[7] : null;
  } catch (error) {
    console.error('Error extracting video ID:', error);
    return null;
  }
}

// Create a fallback ID in case URL parsing fails
function createFallbackId(url) {
  // Generate a consistent ID based on the URL
  return 'fb_' + Math.abs(url.split('').reduce((a, b) => (a * 31 + b.charCodeAt(0)) | 0, 0)).toString(16).substring(0, 9);
}

// Initialize categories
function initializeCategories() {
  const defaultCategories = ['Entertainment', 'Education', 'Music', 'Technology', 'Sports'];
  const existingCategories = store.get('youtube-categories');
  
  if (!existingCategories) {
    store.set('youtube-categories', defaultCategories);
  }
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets/icons/icon.png'),
    backgroundColor: '#ffffff',
    show: false
  });

  // Load the index.html of the app
  mainWindow.loadFile('index.html');

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Maximize on first run
    if (!fs.existsSync(path.join(app.getPath('userData'), 'window-state.json'))) {
      mainWindow.maximize();
    }
  });

  // Handle window state
  mainWindow.on('close', (event) => {
    if (mainWindow) {
      // Save window state
      const windowState = {
        bounds: mainWindow.getBounds()
      };
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'window-state.json'),
        JSON.stringify(windowState)
      );
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Create application menu
  createMenu();
}

// Build the application menu
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Export Data',
          click: () => mainWindow.webContents.send('menu-export-data')
        },
        {
          label: 'Import Data',
          click: () => mainWindow.webContents.send('menu-import-data')
        },
        { type: 'separator' },
        {
          label: 'Settings',
          click: () => mainWindow.webContents.send('menu-settings')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Focus Mode',
          click: () => mainWindow.webContents.send('toggle-focus-mode')
        },
        {
          label: 'Pomodoro Timer',
          click: () => mainWindow.webContents.send('open-pomodoro')
        },
        { type: 'separator' },
        {
          label: 'Keyboard Shortcuts',
          click: () => mainWindow.webContents.send('show-shortcuts')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: async () => {
            await shell.openExternal('https://github.com/yourusername/daily-progress-tracker');
          }
        },
        {
          label: 'About',
          click: () => mainWindow.webContents.send('show-about')
        }
      ]
    }
  ];

  // Special case for Mac
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideothers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// IPC handlers for file operations
ipcMain.handle('save-file', async (event, { content, filename, defaultPath }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath || filename,
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (!canceled && filePath) {
    fs.writeFileSync(filePath, content);
    return { success: true, filePath };
  }
  
  return { success: false };
});

ipcMain.handle('open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (!canceled && filePaths.length > 0) {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    return { success: true, content, filePath: filePaths[0] };
  }
  
  return { success: false };
});

// Show native notifications
ipcMain.handle('show-notification', (event, { title, body, silent }) => {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: title,
      body: body,
      silent: silent || false,
      icon: path.join(__dirname, 'icon.png')
    });
    
    notification.show();
    return true;
  }
  return false;
});

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
  createWindow();

  // Handle macOS behavior
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Set up IPC handlers
  setupIPCHandlers();
});

// Handle window-all-closed event
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle before-quit event
app.on('before-quit', () => {
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.close();
  }
});

// IPC Handlers for YouTube links
ipcMain.handle('get-youtube-info', async (event, url) => {
  try {
    return await getVideoDetails(url);
  } catch (error) {
    console.error('Error in get-youtube-info:', error);
    return {
      error: error.message,
      id: null,
      title: 'Error fetching video details',
      duration: 'Unknown',
      thumbnail: null
    };
  }
});

// Get all categories
ipcMain.handle('get-youtube-categories', (event) => {
  try {
    const categories = store.get('youtube-categories', []);
    console.log('Retrieved YouTube categories:', categories);
    return categories;
  } catch (error) {
    console.error('Error in get-youtube-categories:', error);
    return [];
  }
});

// Add a new category
ipcMain.handle('add-youtube-category', async (event, category) => {
  try {
    console.log('Adding YouTube category:', category);
    const categories = store.get('youtube-categories', []);
    if (!categories.includes(category)) {
      categories.push(category);
      store.set('youtube-categories', categories);
      console.log('Successfully added YouTube category');
      return { success: true };
    }
    return { success: false, error: 'Category already exists' };
  } catch (error) {
    console.error('Error in add-youtube-category:', error);
    return { success: false, error: error.message };
  }
});

// Add a YouTube link with category
ipcMain.handle('add-youtube-link', async (event, linkData) => {
  try {
    console.log('Adding YouTube link:', linkData);
    const links = store.get('youtube-links', []);
    links.push(linkData);
    store.set('youtube-links', links);
    console.log('Successfully added YouTube link');
    return { success: true };
  } catch (error) {
    console.error('Error in add-youtube-link:', error);
    return { success: false, error: error.message };
  }
});

// Update a YouTube link's category
ipcMain.handle('update-youtube-link-category', (event, { id, category }) => {
  const links = store.get('youtube-links') || [];
  const updatedLinks = links.map(link => 
    link.id === id ? { ...link, category } : link
  );
  store.set('youtube-links', updatedLinks);
  return updatedLinks;
});

// Get all YouTube links
ipcMain.handle('get-youtube-links', (event) => {
  try {
    const links = store.get('youtube-links', []);
    console.log('Retrieved YouTube links:', links);
    return links;
  } catch (error) {
    console.error('Error in get-youtube-links:', error);
    return [];
  }
});

// IPC Handlers for reminders
ipcMain.handle('add-reminder', (event, reminder) => {
  const reminders = store.get('reminders') || [];
  reminders.push({
    ...reminder,
    id: Date.now().toString()
  });
  store.set('reminders', reminders);
  return reminders;
});

ipcMain.handle('get-reminders', () => {
  return store.get('reminders') || [];
});

// IPC Handlers for tasks
ipcMain.handle('add-task', (event, task) => {
  const tasks = store.get('tasks') || [];
  tasks.push({
    ...task,
    id: Date.now().toString(),
    completed: false
  });
  store.set('tasks', tasks);
  return tasks;
});

ipcMain.handle('update-task', (event, { id, completed }) => {
  const tasks = store.get('tasks') || [];
  const updatedTasks = tasks.map(task => 
    task.id === id ? { ...task, completed } : task
  );
  store.set('tasks', updatedTasks);
  return updatedTasks;
});

ipcMain.handle('get-tasks', () => {
  return store.get('tasks') || [];
});

// IPC Handlers for scheduled items
ipcMain.handle('update-schedule', (event, schedule) => {
  store.set('schedule', schedule);
  return schedule;
});

ipcMain.handle('get-schedule', () => {
  return store.get('schedule') || [];
});

// Handle IPC messages (communication between renderer and main processes)
function setupIPCHandlers() {
  // YouTube URL info fetch using yt-dlp
  ipcMain.handle('fetch-youtube-info', async (event, url) => {
    try {
      const result = await ytdlp(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
      });
      
      return {
        success: true,
        data: {
          title: result.title,
          duration: result.duration,
          thumbnail: result.thumbnail,
          channel: result.channel,
          uploadDate: result.upload_date
        }
      };
    } catch (error) {
      console.error('Error fetching YouTube info:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  // File export
  ipcMain.handle('export-data', async (event, { format, data }) => {
    try {
      const options = {
        title: 'Save Data',
        defaultPath: path.join(app.getPath('documents'), `daily-progress-export.${format}`),
        buttonLabel: 'Export',
        filters: [
          { name: 'All Files', extensions: ['*'] }
        ]
      };

      if (format === 'json') {
        options.filters.unshift({ name: 'JSON Files', extensions: ['json'] });
      } else if (format === 'csv') {
        options.filters.unshift({ name: 'CSV Files', extensions: ['csv'] });
      } else if (format === 'ics') {
        options.filters.unshift({ name: 'Calendar Files', extensions: ['ics'] });
      }

      const { canceled, filePath } = await dialog.showSaveDialog(options);
      
      if (canceled || !filePath) {
        return { success: false, message: 'Export cancelled' };
      }

      fs.writeFileSync(filePath, data, 'utf-8');
      
      return { success: true, message: 'Data exported successfully', filePath };
    } catch (error) {
      console.error('Export error:', error);
      return { success: false, message: error.message };
    }
  });

  // File import
  ipcMain.handle('import-data', async (event, { format }) => {
    try {
      const options = {
        title: 'Import Data',
        buttonLabel: 'Import',
        filters: [
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      };

      if (format === 'json') {
        options.filters.unshift({ name: 'JSON Files', extensions: ['json'] });
      } else if (format === 'csv') {
        options.filters.unshift({ name: 'CSV Files', extensions: ['csv'] });
      } else if (format === 'ics') {
        options.filters.unshift({ name: 'Calendar Files', extensions: ['ics'] });
      }

      const { canceled, filePaths } = await dialog.showOpenDialog(options);
      
      if (canceled || filePaths.length === 0) {
        return { success: false, message: 'Import cancelled' };
      }

      const data = fs.readFileSync(filePaths[0], 'utf-8');
      
      return { success: true, data, message: 'Data imported successfully' };
    } catch (error) {
      console.error('Import error:', error);
      return { success: false, message: error.message };
    }
  });

  // Persistent data storage
  ipcMain.handle('store-set', async (event, key, value) => {
    try {
      store.set(key, value);
      return { success: true };
    } catch (error) {
      console.error('Error in store-set:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('store-get', (event, key) => {
    try {
      return store.get(key);
    } catch (error) {
      console.error('Error in store-get:', error);
      return null;
    }
  });

  ipcMain.handle('store-delete', (event, key) => {
    store.delete(key);
    return true;
  });

  // Open links in external browser
  ipcMain.handle('open-external', async (event, url) => {
    await shell.openExternal(url);
    return true;
  });

  // Delete a YouTube link
  ipcMain.handle('delete-youtube-link', async (event, id) => {
    try {
      console.log('Deleting YouTube link with ID:', id);
      const links = store.get('youtube-links', []);
      const filteredLinks = links.filter(link => link.id !== id);
      
      if (links.length === filteredLinks.length) {
        console.warn('No link found with ID:', id);
        return { success: false, error: 'Link not found' };
      }
      
      store.set('youtube-links', filteredLinks);
      console.log('Successfully deleted YouTube link');
      return { success: true };
    } catch (error) {
      console.error('Error in delete-youtube-link:', error);
      return { success: false, error: error.message };
    }
  });

  // Handle YouTube video info fetch using yt-dlp
  ipcMain.handle('fetch-video-info', async (event, videoUrl) => {
    console.log('Fetching video info using yt-dlp:', videoUrl);
    
    return new Promise((resolve, reject) => {
      // Set up the command args
      const args = ['--dump-json', '--no-playlist', videoUrl];
      
      console.log(`Running command: ${ytDlpPath} ${args.join(' ')}`);
      
      const ytDlpProcess = spawn(ytDlpPath, args);
      let stdout = '';
      let stderr = '';
      
      ytDlpProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      ytDlpProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ytDlpProcess.on('close', (code) => {
        console.log(`yt-dlp process exited with code ${code}`);
        
        if (code === 0 && stdout) {
          try {
            const videoInfo = JSON.parse(stdout);
            
            // Extract relevant information
            const result = {
              id: videoInfo.id,
              title: videoInfo.title,
              thumbnail: videoInfo.thumbnail,
              uploadDate: videoInfo.upload_date,
              duration: videoInfo.duration,
              viewCount: videoInfo.view_count,
              likeCount: videoInfo.like_count,
              channel: videoInfo.channel,
              channelId: videoInfo.channel_id,
              description: videoInfo.description,
              categories: videoInfo.categories,
              tags: videoInfo.tags,
              formats: videoInfo.formats ? videoInfo.formats.map(f => ({
                formatId: f.format_id,
                formatNote: f.format_note,
                ext: f.ext,
                resolution: f.resolution,
                filesize: f.filesize,
                tbr: f.tbr,
                protocol: f.protocol,
                vcodec: f.vcodec,
                acodec: f.acodec,
                url: f.url
              })) : []
            };
            
            resolve(result);
          } catch (error) {
            console.error('Error parsing yt-dlp output:', error);
            reject(new Error(`Failed to parse video info: ${error.message}`));
          }
        } else {
          console.error('yt-dlp error:', stderr);
          reject(new Error(`yt-dlp failed with code ${code}: ${stderr}`));
        }
      });
      
      ytDlpProcess.on('error', (error) => {
        console.error('Failed to start yt-dlp process:', error);
        reject(new Error(`Failed to start yt-dlp process: ${error.message}. Please make sure yt-dlp is installed correctly.`));
      });
    });
  });

  // Handle YouTube video download
  ipcMain.handle('download-youtube-video', async (event, videoUrl, options) => {
    console.log('Downloading video using yt-dlp:', videoUrl, options);
    
    // Allow user to select download directory if not specified
    let downloadDir = options.directory;
    if (!downloadDir) {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: 'Select Download Folder',
          defaultPath: path.join(os.homedir(), 'Downloads')
        });
        
        if (!result.canceled && result.filePaths.length > 0) {
          downloadDir = result.filePaths[0];
        } else {
          // User canceled the dialog
          return { canceled: true };
        }
      } catch (error) {
        console.error('Error showing directory dialog:', error);
        downloadDir = path.join(os.homedir(), 'Downloads');
      }
    }
    
    // Ensure download directory exists
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    return new Promise((resolve, reject) => {
      // Set up download arguments
      const args = [
        '--no-playlist',
        '-o', path.join(downloadDir, '%(title)s.%(ext)s')
      ];
      
      // Add format option if specified
      if (options.format) {
        args.push('-f', options.format);
      }
      
      // Add audio-only option if specified
      if (options.audioOnly) {
        args.push('-x', '--audio-format', options.audioFormat || 'mp3');
      }
      
      // Add additional options
      if (options.embedThumbnail) {
        args.push('--embed-thumbnail');
      }
      
      if (options.addMetadata) {
        args.push('--add-metadata');
      }
      
      if (options.subtitles) {
        args.push('--write-auto-sub', '--sub-lang', options.subtitleLanguage || 'en');
      }
      
      // Add the video URL
      args.push(videoUrl);
      
      console.log(`Running download command: ${ytDlpPath} ${args.join(' ')}`);
      
      const ytDlpProcess = spawn(ytDlpPath, args);
      let output = '';
      let progressPercent = 0;
      let filename = '';
      
      ytDlpProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        
        // Try to parse progress percentage
        const progressMatch = chunk.match(/(\d+\.\d+)%/);
        if (progressMatch) {
          progressPercent = parseFloat(progressMatch[1]);
          event.sender.send('download-progress', { videoUrl, progress: progressPercent });
        }
        
        // Try to parse output filename
        const filenameMatch = chunk.match(/Destination: (.+)/);
        if (filenameMatch) {
          filename = filenameMatch[1];
        }
        
        // Also try to match the "[download] ... of ..." format
        const downloadMatch = chunk.match(/\[download\]\s+(\d+\.\d+)%/);
        if (downloadMatch) {
          progressPercent = parseFloat(downloadMatch[1]);
          event.sender.send('download-progress', { videoUrl, progress: progressPercent });
        }
      });
      
      ytDlpProcess.stderr.on('data', (data) => {
        output += data.toString();
      });
      
      ytDlpProcess.on('close', async (code) => {
        console.log(`yt-dlp download process exited with code ${code}`);
        
        if (code === 0) {
          resolve({
            success: true,
            message: 'Download completed successfully',
            path: filename || downloadDir,
            output
          });
        } else {
          console.error('yt-dlp download error:', output);
          reject(new Error(`Download failed with code ${code}: ${output}`));
        }
      });
      
      ytDlpProcess.on('error', (error) => {
        console.error('Failed to start yt-dlp download process:', error);
        reject(new Error(`Failed to start yt-dlp download process: ${error.message}`));
      });
    });
  });

  // Show video file in folder
  ipcMain.handle('show-in-folder', async (event, filePath) => {
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return { success: true };
    } else {
      return { success: false, error: 'File not found' };
    }
  });
}

// In this file you can include the rest of your app's specific main process code. 