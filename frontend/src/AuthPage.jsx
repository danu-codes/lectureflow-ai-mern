import { useState } from 'react';
import { AudioLines, ArrowRight, BookOpenText, Eye, EyeOff, LockKeyhole, Mail, Mic, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { api } from './api';

export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const register = mode === 'register';

  async function submit(e) {
    e.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const { user } = await api(`/auth/${register ? 'register' : 'login'}`, {
        method: 'POST',
        body: register ? { name: name.trim(), email: email.trim(), password } : { email: email.trim(), password }
      });
      setPassword('');
      onAuth(user);
    } catch (e) {
      setError(e.message || 'Unable to sign in.');
    } finally { setLoading(false); }
  }
  function switchMode(next) {
    setMode(next); setError(''); setPassword('');
  }

  return <div className="auth-shell">
    <section className="auth-showcase" aria-label="About LectureFlow AI">
      <div className="auth-showcase-inner">
        <div className="auth-brand"><span className="brand-icon"><AudioLines size={22}/></span><strong>LectureFlow <em>AI</em></strong></div>
        <span className="auth-kicker"><Sparkles size={14}/> YOUR SMART STUDY COMPANION</span>
        <h1>Focus on the lecture.<br/><span>We'll handle the notes.</span></h1>
        <p>Record your classes, follow live captions, and turn captured speech into clear, organized study notes.</p>
        <div className="auth-feature-list">
          <div><span><Mic size={20}/></span><div><strong>Capture lectures</strong><small>Recording and live transcription</small></div></div>
          <div><span><BookOpenText size={20}/></span><div><strong>Study-ready notes</strong><small>Automatic summaries after you stop</small></div></div>
          <div><span><ShieldCheck size={20}/></span><div><strong>Your private library</strong><small>Access transcripts and notes on any signed-in device</small></div></div>
        </div>
      </div>
      <div className="auth-bottom-note">Local audio recordings stay in the browser where you recorded them.</div>
    </section>

    <main className="auth-panel">
      <div className="auth-form-wrap">
        <div className="auth-mobile-brand"><AudioLines size={22}/> LectureFlow AI</div>
        <div className="auth-form-kicker">{register ? 'START YOUR JOURNEY' : 'WELCOME BACK'}</div>
        <h2>{register ? 'Create your account' : 'Sign in to LectureFlow'}</h2>
        <p className="auth-intro">{register ? 'Keep your lecture notes connected to one secure account.' : 'Access your lectures, transcripts and organized notes.'}</p>
        <form className="auth-form" onSubmit={submit}>
          {register && <label className="auth-field"><span>Full name</span><div className="auth-input"><UserRound size={18}/><input autoComplete="name" minLength={2} maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="Your full name" required /></div></label>}
          <label className="auth-field"><span>Email address</span><div className="auth-input"><Mail size={18}/><input type="email" autoComplete="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required /></div></label>
          <label className="auth-field"><span>Password</span><div className="auth-input"><LockKeyhole size={18}/><input type={showPassword ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 10 : undefined} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} placeholder={register ? 'At least 10 characters' : 'Enter your password'} required /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} className="auth-show-password" onClick={()=>setShowPassword(v=>!v)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="auth-submit" disabled={loading} type="submit">{loading ? 'Please wait...' : register ? 'Create account' : 'Sign in'} {!loading && <ArrowRight size={18}/>}</button>
        </form>
        <div className="auth-switch">{register ? 'Already have an account?' : 'New to LectureFlow?'} <button type="button" onClick={()=>switchMode(register ? 'login' : 'register')}>{register ? 'Sign in' : 'Create an account'}</button></div>
        <div className="auth-hint"><ShieldCheck size={17}/> Your password is securely hashed. Your saved notes belong to your account.</div>
      </div>
    </main>
  </div>;
}
