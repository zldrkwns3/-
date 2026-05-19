import { useState } from 'react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../lib/firebase.ts';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setError(err.message || '인증 오류');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] p-4">
      <div className="bg-white p-8 rounded-xl shadow-lg max-w-sm w-full border border-gray-200 animate-in fade-in zoom-in-95 duration-300">
        <h2 className="text-2xl font-bold mb-2 text-center text-gray-900">{isLogin ? '로그인 (Login)' : '회원가입 (Sign Up)'}</h2>
        <p className="text-xs font-mono text-center text-gray-500 mb-6 opacity-80 uppercase tracking-wider">
          AI Auto-Trading Platform
        </p>
        
        {error && (
          <div className="mb-4 text-xs text-red-600 bg-red-50 border border-red-100 p-3 rounded text-center break-words">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[10px] font-mono uppercase text-gray-500 mb-1">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border-b border-gray-200 bg-transparent p-2 text-sm focus:outline-none focus:border-gray-900 transition-colors"
              required
              disabled={loading}
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono uppercase text-gray-500 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border-b border-gray-200 bg-transparent p-2 text-sm focus:outline-none focus:border-gray-900 transition-colors"
              required
              disabled={loading}
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gray-900 text-white font-bold text-xs uppercase tracking-widest py-3 mt-4 hover:bg-black transition-colors disabled:opacity-50"
          >
            {loading ? '처리 중...' : (isLogin ? '로그인 시도 →' : '계정 생성 →')}
          </button>
        </form>

        <div className="mt-6 text-center text-[10px] font-mono uppercase text-gray-500">
          {isLogin ? '계정이 없으신가요?' : '이미 계정이 있으신가요?'}{' '}
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="text-blue-600 border-b border-transparent hover:border-blue-600 transition-colors ml-1 font-bold"
          >
            {isLogin ? '가입하기' : '로그인하기'}
          </button>
        </div>
      </div>
      
      <div className="mt-8 max-w-sm text-center text-xs text-gray-500 bg-blue-50 border border-blue-100 p-4 rounded-xl">
         <strong>주의:</strong><br /> 만약 "auth/operation-not-allowed" 에러가 발생한다면,<br />
         Firebase Console에서 <strong>Authentication &gt; Sign-in method</strong><br />
         로 이동하여 <strong>Email/Password</strong> 제공업체를 반드시 활성화(Enable) 해주셔야 합니다.
      </div>
    </div>
  );
}
