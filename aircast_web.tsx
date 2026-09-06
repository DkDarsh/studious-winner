import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  signInWithCustomToken, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  updateDoc, 
  onSnapshot,
  serverTimestamp,
  arrayUnion
} from 'firebase/firestore';
import { 
  MonitorPlay, 
  Smartphone, 
  Cast, 
  XCircle, 
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileUp,
  Download,
  Image as ImageIcon,
  File as FileIcon,
  Moon,
  Sun
} from 'lucide-react';

const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState('home');
  const [roomId, setRoomId] = useState('');
  const [inputRoomId, setInputRoomId] = useState(['', '', '', '', '', '', '', '', '']);
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [activeTab, setActiveTab] = useState('receive');
  
  // Theme State
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  // File Transfer States
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [receivingFile, setReceivingFile] = useState(null);
  const [sendingFile, setSendingFile] = useState(null);

  const pcRef = useRef(null);
  const dataChannelRef = useRef(null);
  const unsubscribeRef = useRef(null);
  const processedCandidates = useRef(new Set());
  const inputRefs = useRef([]);
  const receiveBuffer = useRef([]);
  const receivingFileRef = useRef(null);

  useEffect(() => {
    const root = window.document.documentElement;
    if (isDarkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Authentication Error:", error);
        setErrorMessage("Failed to connect to the server.");
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });

    return () => {
      unsubscribe();
      cleanupConnection();
    };
  }, []);

  const cleanupConnection = () => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    processedCandidates.current.clear();
    setReceivingFile(null);
    setSendingFile(null);
    receiveBuffer.current = [];
    receivingFileRef.current = null;
  };

  const goHome = () => {
    cleanupConnection();
    setMode('home');
    setStatus('idle');
    setRoomId('');
    setInputRoomId(['', '', '', '', '', '', '', '', '']);
    setErrorMessage('');
  };

  const setupDataChannel = (channel) => {
    channel.binaryType = 'arraybuffer';
    
    channel.onopen = () => {
      setStatus('connected');
    };
    
    channel.onclose = () => {
      setStatus('error');
      setErrorMessage('Connection closed by peer.');
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'meta') {
            const fileData = { name: msg.name, size: msg.size, mimeType: msg.mimeType, receivedSize: 0 };
            setReceivingFile(fileData);
            receivingFileRef.current = fileData;
            receiveBuffer.current = [];
          } else if (msg.type === 'end') {
            // FIX: Safeguard against race conditions if connection closes mid-transfer
            if (!receivingFileRef.current) return; 
            
            // Extract values outside the state updater to avoid stale references
            const currentFile = receivingFileRef.current;
            const blob = new Blob(receiveBuffer.current);
            const url = URL.createObjectURL(blob);
            
            setReceivedFiles(prev => [...prev, {
              id: Date.now(),
              name: currentFile.name,
              size: currentFile.size,
              mimeType: currentFile.mimeType,
              url
            }]);
            
            setReceivingFile(null);
            receivingFileRef.current = null;
          }
        } catch (e) {
          console.error("Invalid message received:", e);
        }
      } else {
        receiveBuffer.current.push(event.data);
        setReceivingFile(prev => {
          if (!prev) return prev; // Safe fallback if data arrives late
          const updated = { ...prev, receivedSize: prev.receivedSize + event.data.byteLength };
          receivingFileRef.current = updated;
          return updated;
        });
      }
    };
  };

  const startReceiver = async () => {
    if (!user) return;
    cleanupConnection();
    
    const newRoomId = Math.floor(100000000 + Math.random() * 900000000).toString();
    setRoomId(newRoomId);
    setMode('receiver');
    setStatus('waiting');
    setErrorMessage('');

    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setStatus('error');
        setErrorMessage('Connection lost.');
      }
    });

    pc.ondatachannel = (event) => {
      dataChannelRef.current = event.channel;
      setupDataChannel(event.channel);
    };

    const roomRef = doc(db, 'artifacts', appId, 'public', 'data', 'webrtc_rooms', newRoomId);
    await setDoc(roomRef, { 
      createdAt: serverTimestamp(), 
      callerCandidates: [], 
      calleeCandidates: [] 
    });

    pc.addEventListener('icecandidate', event => {
      if (event.candidate) {
        updateDoc(roomRef, {
          calleeCandidates: arrayUnion(JSON.stringify(event.candidate.toJSON()))
        }).catch(err => console.error("Error adding callee candidate:", err));
      }
    });

    unsubscribeRef.current = onSnapshot(roomRef, async snapshot => {
      const data = snapshot.data();
      if (!data) return;

      if (data.offer && !pc.currentRemoteDescription) {
        setStatus('connecting');
        const offer = new RTCSessionDescription(data.offer);
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await updateDoc(roomRef, { 
          answer: { type: answer.type, sdp: answer.sdp } 
        }, { merge: true });
      }

      if (data.callerCandidates && pc.remoteDescription) {
        data.callerCandidates.forEach(async candidateStr => {
          if (!processedCandidates.current.has(candidateStr)) {
            processedCandidates.current.add(candidateStr);
            try {
              await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateStr)));
            } catch (e) {
              console.error("Error adding ice candidate", e);
            }
          }
        });
      }
    });
  };

  const startCasting = async (targetRoomId) => {
    if (!user || !targetRoomId) return;
    cleanupConnection();
    setMode('caster');
    setStatus('connecting');
    setErrorMessage('');

    try {
      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;

      const dataChannel = pc.createDataChannel('fileTransfer');
      dataChannelRef.current = dataChannel;
      setupDataChannel(dataChannel);

      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          setStatus('error');
          setErrorMessage('Connection lost.');
        }
      });

      const roomRef = doc(db, 'artifacts', appId, 'public', 'data', 'webrtc_rooms', targetRoomId);

      pc.addEventListener('icecandidate', event => {
        if (event.candidate) {
          updateDoc(roomRef, {
            callerCandidates: arrayUnion(JSON.stringify(event.candidate.toJSON()))
          }, { merge: true }).catch(err => console.error("Error adding caller candidate:", err));
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      await setDoc(roomRef, { 
        offer: { type: offer.type, sdp: offer.sdp } 
      }, { merge: true });

      unsubscribeRef.current = onSnapshot(roomRef, async snapshot => {
        const data = snapshot.data();
        if (!data) {
          setStatus('error');
          setErrorMessage("Room not found. Make sure the PIN is correct.");
          return;
        }

        if (data.answer && !pc.currentRemoteDescription) {
          const answer = new RTCSessionDescription(data.answer);
          await pc.setRemoteDescription(answer);
        }

        if (data.calleeCandidates && pc.remoteDescription) {
          data.calleeCandidates.forEach(async candidateStr => {
            if (!processedCandidates.current.has(candidateStr)) {
              processedCandidates.current.add(candidateStr);
              try {
                await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateStr)));
              } catch (e) {
                console.error("Error adding ice candidate", e);
              }
            }
          });
        }
      }, error => {
        console.error("Snapshot error:", error);
        setErrorMessage("Network error. Please check your internet connection.");
      });

    } catch (err) {
      console.error("Connection error:", err);
      setStatus('error');
      setErrorMessage("Failed to establish connection.");
    }
  };

  const sendFile = (file) => {
    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') return;
    
    setSendingFile({ name: file.name, progress: 0 });
    const chunkSize = 16384; 
    const fileReader = new FileReader();
    let offset = 0;

    dataChannelRef.current.send(JSON.stringify({
      type: 'meta',
      name: file.name,
      size: file.size,
      mimeType: file.type
    }));
    
    fileReader.addEventListener('load', e => {
      dataChannelRef.current.send(e.target.result);
      offset += e.target.result.byteLength;
      
      const progress = Math.round((offset / file.size) * 100);
      setSendingFile(prev => prev ? { ...prev, progress } : null);

      if (offset < file.size) {
        readSlice(offset);
      } else {
        dataChannelRef.current.send(JSON.stringify({ type: 'end' }));
        setTimeout(() => setSendingFile(null), 1000);
      }
    });

    const readSlice = o => {
      const slice = file.slice(offset, o + chunkSize);
      fileReader.readAsArrayBuffer(slice);
    };

    readSlice(0);
  };

  const handleInputChange = (index, value) => {
    const numericValue = value.replace(/\D/g, '');
    if (numericValue.length <= 1) {
      const newInputs = [...inputRoomId];
      newInputs[index] = numericValue;
      setInputRoomId(newInputs);
      
      if (numericValue !== '' && index < 8) {
        inputRefs.current[index + 1].focus();
      }
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && inputRoomId[index] === '' && index > 0) {
      inputRefs.current[index - 1].focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 9);
    if (pastedData) {
      const newInputs = [...inputRoomId];
      for (let i = 0; i < pastedData.length; i++) {
        newInputs[i] = pastedData[i];
      }
      setInputRoomId(newInputs);
      const nextIndex = Math.min(pastedData.length, 8);
      if (inputRefs.current[nextIndex]) {
        inputRefs.current[nextIndex].focus();
      }
    }
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans flex flex-col items-center justify-center p-0 sm:p-4 selection:bg-indigo-100 dark:selection:bg-indigo-900 transition-colors duration-300">
      
      {/* Header */}
      <div className="absolute top-4 left-4 sm:top-6 sm:left-6 flex items-center space-x-2 cursor-pointer transition-transform hover:scale-105 active:scale-95 z-50" onClick={goHome}>
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
          <Cast className="w-5 h-5 text-white" />
        </div>
        <h1 className="text-xl font-bold text-slate-800 dark:text-white tracking-tight">
          AirCast <span className="text-indigo-600 dark:text-indigo-400 font-black">Drop</span>
        </h1>
      </div>

      <div className="absolute top-4 right-4 sm:top-6 sm:right-6 z-50">
        <button 
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full shadow-sm text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
        >
          {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </div>

      {/* Main Container */}
      <div className="w-full max-w-[800px] bg-white dark:bg-slate-900 sm:border border-slate-200 dark:border-slate-800 sm:rounded-3xl sm:shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:sm:shadow-[0_8px_30px_rgb(0,0,0,0.2)] overflow-hidden relative min-h-[100dvh] sm:min-h-0 pt-16 sm:pt-0 flex flex-col transition-colors duration-300">
        
        {errorMessage && (
          <div className="absolute top-0 left-0 right-0 bg-red-500/10 dark:bg-red-900/30 border-b border-red-500/20 text-red-600 dark:text-red-400 px-4 py-3 flex items-center justify-between text-sm z-50 backdrop-blur-md">
            <div className="flex items-center">
              <AlertCircle className="w-4 h-4 mr-2" />
              {errorMessage}
            </div>
            <button onClick={() => setErrorMessage('')} className="hover:bg-red-500/10 p-1 rounded-full transition-colors"><XCircle className="w-4 h-4" /></button>
          </div>
        )}

        {/* HOME MODE */}
        {mode === 'home' && (
          <div className="flex flex-col w-full flex-1">
            <div className="flex w-full border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
               <button 
                  onClick={() => setActiveTab('receive')}
                  className={`flex-1 py-3 sm:py-4 text-xs sm:text-sm font-semibold tracking-wide transition-colors ${activeTab === 'receive' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400 bg-white dark:bg-slate-800/50' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
               >
                  Receive Files (Laptop)
               </button>
               <button 
                  onClick={() => setActiveTab('cast')}
                  className={`flex-1 py-3 sm:py-4 text-xs sm:text-sm font-semibold tracking-wide transition-colors ${activeTab === 'cast' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400 bg-white dark:bg-slate-800/50' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
               >
                  Send Files (Phone)
               </button>
            </div>

            <div className="p-4 sm:p-12 flex-1 flex flex-col justify-center">
               {activeTab === 'receive' && (
                  <div className="flex flex-col items-center justify-center py-4 sm:py-6 text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                     <div className="w-16 h-16 sm:w-20 sm:h-20 bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 border border-indigo-100 dark:border-indigo-500/20">
                        <MonitorPlay className="w-8 h-8 sm:w-10 sm:h-10 text-indigo-500 dark:text-indigo-400" />
                     </div>
                     <h2 className="text-xl sm:text-2xl font-bold mb-3 text-slate-800 dark:text-white">Receive from Phone</h2>
                     <p className="text-slate-500 dark:text-slate-400 mb-6 sm:mb-8 max-w-sm text-xs sm:text-sm leading-relaxed px-4">
                        Generate a secure Cast Code. Enter this code on your phone to instantly drop photos and files directly to this screen without cables.
                     </p>
                     <button 
                        onClick={startReceiver}
                        className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 px-8 rounded-xl shadow-lg shadow-indigo-600/20 transition-all hover:-translate-y-0.5 active:translate-y-0"
                     >
                        Generate Cast Code
                     </button>
                  </div>
               )}

               {activeTab === 'cast' && (
                  <div className="flex flex-col items-center justify-center py-4 sm:py-6 text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                     <div className="w-16 h-16 sm:w-20 sm:h-20 bg-cyan-50 dark:bg-cyan-900/20 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 border border-cyan-100 dark:border-cyan-500/20">
                        <Smartphone className="w-8 h-8 sm:w-10 sm:h-10 text-cyan-600 dark:text-cyan-400" />
                     </div>
                     <h2 className="text-xl sm:text-2xl font-bold mb-6 text-slate-800 dark:text-white">Enter Cast Code</h2>
                     
                     <div className="flex justify-center items-center gap-0.5 sm:gap-2 mb-8 w-full flex-nowrap" onPaste={handlePaste}>
                        {inputRoomId.map((digit, idx) => (
                           <React.Fragment key={idx}>
                              <input 
                                 ref={el => inputRefs.current[idx] = el}
                                 type="text"
                                 inputMode="numeric"
                                 pattern="[0-9]*"
                                 maxLength={1}
                                 value={digit}
                                 onChange={(e) => handleInputChange(idx, e.target.value)}
                                 onKeyDown={(e) => handleKeyDown(idx, e)}
                                 className="w-7 h-10 min-[375px]:w-8 min-[375px]:h-12 sm:w-12 sm:h-16 shrink-0 text-center text-lg min-[375px]:text-xl sm:text-2xl font-bold bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md sm:rounded-lg focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900 outline-none transition-all shadow-sm p-0 text-slate-900 dark:text-white"
                              />
                              {(idx === 2 || idx === 5) && <div className="text-slate-400 dark:text-slate-600 font-bold mx-0.5 shrink-0">-</div>}
                           </React.Fragment>
                        ))}
                     </div>
                     
                     <button 
                        onClick={() => startCasting(inputRoomId.join(''))}
                        disabled={inputRoomId.join('').length !== 9}
                        className="w-full max-w-xs bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white font-medium py-3 px-8 rounded-xl shadow-lg shadow-indigo-600/20 transition-all active:scale-95 flex justify-center items-center"
                     >
                        <Cast className="w-5 h-5 mr-2" /> Connect to Laptop
                     </button>
                  </div>
               )}
            </div>
          </div>
        )}

        {/* RECEIVER MODE (LAPTOP VIEW) */}
      {mode === 'receiver' && (
        <div className="flex flex-col sm:flex-row h-full flex-1 sm:h-[600px] overflow-hidden">
          
          {/* Sidebar / Connection Info */}
          <div className="w-full sm:w-[360px] bg-white dark:bg-slate-900 border-b sm:border-b-0 sm:border-r border-slate-100 dark:border-slate-800 p-6 sm:p-8 flex flex-col items-center sm:items-start shrink-0 relative z-10 shadow-[0_4px_24px_rgb(0,0,0,0.02)] sm:shadow-[4px_0_24px_rgb(0,0,0,0.02)]">
             <h3 className="text-xs sm:text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Cast Code</h3>
               <p className="text-xs text-slate-500 dark:text-slate-400 mb-6 text-center sm:text-left">Enter this on your phone</p>
               
               {/* Single line display for the Cast Code */}
               <div className="text-2xl sm:text-3xl font-bold tracking-[0.1em] sm:tracking-widest text-slate-800 dark:text-slate-100 mb-8 font-mono flex items-center justify-center bg-slate-50 dark:bg-slate-800/50 py-4 px-2 rounded-xl border border-slate-100 dark:border-slate-700/50 w-full whitespace-nowrap">
                  {roomId.slice(0,3)}-{roomId.slice(3,6)}-{roomId.slice(6,9)}
               </div>
          </div>

          {/* Main Content Area (Received Files Dashboard) */}
          <div className="flex-1 min-h-0 p-4 sm:p-8 bg-slate-50 dark:bg-slate-950 flex flex-col h-full overflow-y-auto">
             
             {status !== 'connected' ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-600 text-center animate-in fade-in duration-1000 py-10 min-h-[300px]">
                   <FileUp className="w-12 h-12 sm:w-16 sm:h-16 mb-4 opacity-20" />
                   <p className="max-w-xs text-xs sm:text-sm">Once your phone connects, files and photos you send will appear here instantly.</p>
                </div>
             ) : (
                <>
                     <div className="flex items-center justify-between mb-4 sm:mb-8 border-b border-slate-200 dark:border-slate-800 pb-4">
                        <h2 className="text-xl sm:text-2xl font-semibold text-slate-800 dark:text-slate-100 tracking-tight">Received Files</h2>
                     </div>
                     
                     {receivingFile && (
                        <div className="mb-8 bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-500/20 animate-in fade-in slide-in-from-top-2">
                           <div className="flex justify-between text-sm mb-2">
                              <span className="font-semibold text-indigo-700 dark:text-indigo-300 truncate max-w-[70%]">{receivingFile.name}</span>
                              <span className="text-indigo-600 dark:text-indigo-400">
                                 {Math.round((receivingFile.receivedSize / receivingFile.size) * 100)}%
                              </span>
                           </div>
                           <div className="w-full bg-indigo-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
                              <div 
                                className="bg-indigo-600 dark:bg-indigo-500 h-2 rounded-full transition-all duration-150 ease-out" 
                                style={{ width: `${(receivingFile.receivedSize / receivingFile.size) * 100}%` }}
                              ></div>
                           </div>
                        </div>
                     )}

                     <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 auto-rows-max pb-8">
                        {receivedFiles.map(file => (
                           <div key={file.id} className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 p-3 sm:p-4 flex flex-col items-center group hover:shadow-md transition-shadow animate-in zoom-in-95 duration-300">
                               {file.mimeType.startsWith('image/') ? (
                                  <div className="w-full aspect-square bg-slate-100 dark:bg-slate-800 rounded-lg mb-3 overflow-hidden flex items-center justify-center relative">
                                     <img src={file.url} alt={file.name} className="w-full h-full object-cover" />
                                     <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                         <ImageIcon className="w-8 h-8 text-white" />
                                     </div>
                                  </div>
                               ) : (
                                  <div className="w-full aspect-square bg-slate-100 dark:bg-slate-800 rounded-lg mb-3 flex items-center justify-center group-hover:bg-slate-200 dark:group-hover:bg-slate-700 transition-colors">
                                     <FileIcon className="w-12 h-12 text-slate-400 dark:text-slate-500" />
                                  </div>
                               )}
                               <p className="text-sm text-slate-700 dark:text-slate-200 font-medium truncate w-full text-center mb-1">{file.name}</p>
                               <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                               <a 
                                 href={file.url} 
                                 download={file.name} 
                                 className="w-full py-2 bg-slate-50 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 border border-slate-200 dark:border-slate-700 hover:border-indigo-200 dark:hover:border-indigo-500/50 rounded-lg text-xs sm:text-sm font-medium flex justify-center items-center transition-colors"
                               >
                                  <Download className="w-4 h-4 mr-1 sm:mr-2" /> Save File
                               </a>
                           </div>
                        ))}
                        
                        {receivedFiles.length === 0 && !receivingFile && (
                            <div className="col-span-full py-12 flex flex-col items-center text-slate-400 dark:text-slate-500 text-center px-4">
                               <CheckCircle2 className="w-10 h-10 sm:w-12 sm:h-12 mb-4 text-green-400/50 dark:text-green-500/30" />
                               <p className="text-sm">Connected! Select a file on your phone.</p>
                            </div>
                        )}
                     </div>
                  </>
               )}
            </div>
          </div>
        )}

        {/* CASTER MODE (PHONE VIEW) */}
        {mode === 'caster' && (
          <div className="p-4 sm:p-8 flex flex-col items-center justify-center flex-1 h-full min-h-[400px]">
            {status === 'connecting' ? (
              <div className="flex flex-col items-center text-center">
                <Loader2 className="w-12 h-12 text-cyan-400 animate-spin mb-4" />
                <h3 className="text-xl font-medium text-slate-800 dark:text-white">Connecting...</h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-2">Negotiating direct connection</p>
              </div>
            ) : status === 'connected' ? (
              <div className="flex flex-col items-center w-full max-w-sm animate-in zoom-in-95 duration-500">
                <div className="bg-white dark:bg-slate-900 w-full rounded-3xl shadow-xl dark:shadow-2xl border border-slate-100 dark:border-slate-800 p-6 sm:p-8 mb-8">
                  <div className="flex items-center justify-center mb-8">
                     <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse mr-2"></div>
                     <span className="font-semibold text-slate-700 dark:text-slate-200">Connected Securely</span>
                  </div>
                  
                  <div className="space-y-4">
                    {sendingFile ? (
                       <div className="bg-indigo-50 dark:bg-indigo-900/20 p-6 rounded-3xl border border-indigo-100 dark:border-indigo-500/20 text-center">
                           <Loader2 className="w-8 h-8 text-indigo-500 dark:text-indigo-400 animate-spin mx-auto mb-4" />
                           <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate mb-3">{sendingFile.name}</p>
                           <div className="w-full bg-indigo-200/50 dark:bg-slate-800 rounded-full h-2 overflow-hidden mb-2">
                              <div 
                                className="bg-indigo-600 dark:bg-indigo-500 h-2 rounded-full transition-all duration-150 ease-out" 
                                style={{ width: `${sendingFile.progress}%` }}
                              ></div>
                           </div>
                           <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400">{sendingFile.progress}% Sent</p>
                       </div>
                    ) : (
                       <div className="space-y-4">
                          <div>
                            <input 
                              type="file" 
                              onChange={(e) => {
                                if(e.target.files.length > 0) sendFile(e.target.files[0])
                              }} 
                              className="hidden" 
                              id="file-upload" 
                            />
                            <label 
                              htmlFor="file-upload" 
                              className="w-full aspect-[4/3] bg-indigo-50/50 dark:bg-slate-800/50 hover:bg-indigo-100/50 dark:hover:bg-slate-800 border-2 border-dashed border-indigo-200 dark:border-slate-600 rounded-[2rem] flex flex-col items-center justify-center cursor-pointer transition-all active:scale-[0.98] group p-6"
                            >
                                <div className="w-20 h-20 bg-white dark:bg-slate-900 rounded-full flex items-center justify-center mb-6 shadow-sm border border-slate-100 dark:border-slate-800 group-hover:scale-110 group-hover:shadow-md transition-all">
                                   <FileUp className="w-8 h-8 text-indigo-500 dark:text-indigo-400" />
                                </div>
                                <h4 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Tap to Select File</h4>
                                <p className="text-slate-500 dark:text-slate-400 text-sm text-center">Photos, videos, or documents</p>
                            </label>
                          </div>
                       </div>
                    )}
                  </div>
                </div>

                <button 
                  onClick={goHome}
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-800 sm:bg-transparent font-medium py-3 px-6 rounded-xl sm:rounded-lg transition-colors text-sm w-full max-w-xs"
                >
                  Disconnect Session
                </button>
              </div>
            ) : (
               <div className="flex flex-col items-center text-center">
                  <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
                  <h3 className="text-xl font-medium mb-4 text-slate-800 dark:text-white">Connection Failed</h3>
                  <button onClick={goHome} className="bg-slate-800 dark:bg-slate-700 hover:bg-slate-700 dark:hover:bg-slate-600 text-white px-6 py-2 rounded-lg transition-colors">Try Again</button>
               </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}